import JiraClient from "jira-connector";
import { template } from "lodash";
import { makeClient } from "./jira";
import { getTickets } from "./success";
import { DEFAULT_JIRA_COMMENT, GenerateNotesContext, ITransition, PluginConfig, Transition } from "./types";
import { validateJiraTransitionConfig } from "./util";

async function commentJiraTickets(ticket: string, jira: JiraClient, context: GenerateNotesContext, comment: string) {
  try {
    await jira.issue.editIssue({
      issueKey: ticket,
      issue: {
        update: {
          comment: [
            {
               add: {
                body: comment
               }
            }
         ]
        },
        properties: undefined as any
      }
    })
    context.logger.info(`Jira ticket: ${ticket} is commented!`);
  } catch (error) {
    context.logger.error(`JIRA ticket comment error: ${error}`);
  }
}

async function moveJiraTickets(ticket: string, jira: JiraClient, context: GenerateNotesContext, targetState: string) {
  try {
    await jira.issue.transitionIssue({
      issueKey: ticket,
      transition: {
        id: targetState,
      }
    })
    } catch (error) {
      context.logger.error(`JIRA ticket moving error: ${error}`);
    }
  }

async function getNewStateLabel(ticket: string, newState: string, jira: JiraClient, context: GenerateNotesContext) {
  let foundStatus: any = false
  try {
    context.logger.info(`desired status: ${newState}`);
  const status: ITransition = await jira.issue.getTransitions({
    issueKey: ticket,
  })

  context.logger.info(`statuses: ${JSON.stringify(status)}`);
  const { transitions } = status
  context.logger.info(`transitions: ${JSON.stringify(transitions)}`);
  foundStatus = transitions.find((transition: Transition) => transition.id === newState)
  
  context.logger.info(`foundstatus: ${foundStatus}`);
  return foundStatus
  } catch {
    context.logger.info(`Ticket not found: ${ticket}`);
  }
  return foundStatus
}

  export async function generateNotes(config: PluginConfig, context: GenerateNotesContext): Promise<void> {
    context.logger.info('## start custom jira ticket step');
    context.logger.info(`config: ${JSON.stringify(config)}`);
    const jira = makeClient(config, context);
    const jiraTickets = getTickets(config, context);
    context.logger.info(`Found JIRA tickets: ${jiraTickets}`);
    // @ts-ignore
    const branch = context.envCi.branch
    // @ts-ignore
    context.logger.info(`Current branch: ${context.envCi.branch}`);

    const tickets = jiraTickets
    let ticketComments: any = []
    let ticketMoves: any = []

    if (tickets && tickets.length > 0) {
    if (config.jiraTransitions) {
      context.logger.info(`Jira comment branch: ${branch}`); 
      const isValidConfig = validateJiraTransitionConfig(config.jiraTransitions, branch, context)
      if (isValidConfig) {
        const thisConfig = config.jiraTransitions[branch]
        const commentTemplate = template(thisConfig.comment ?? DEFAULT_JIRA_COMMENT);
        const { targetState } = thisConfig

        ticketComments = tickets.map(async (ticket: string) => {
          const newStatusLabel = await getNewStateLabel(ticket, targetState.toString(), jira, context)
          context.logger.info(`new status label: ${JSON.stringify(newStatusLabel)}`);     
          if (newStatusLabel) {
            const comment = commentTemplate({ newState: newStatusLabel.name })
            if (!config.dryRun) {
              commentJiraTickets(ticket, jira, context, comment)
            } else {
              context.logger.info(`dryRun mode is true, faking commit: ${comment}`)
            }
          } else {
            context.logger.error(`Jira ticket: ${ticket} is not in the correct status to be commented on`);     
          }
        })
        ticketMoves = tickets.map(async (ticket: string) => {          
          const newStatusLabel = await getNewStateLabel(ticket, targetState.toString(), jira, context)
           if (newStatusLabel) {
            if (!config.dryRun) {
              moveJiraTickets(ticket, jira, context, targetState.toString())
            } else {
              context.logger.info(`dryRun mode is true, faking transition for ticket: ${ticket}. Transition would be: ${newStatusLabel}`)
            }
           } else {
            context.logger.error(`Jira ticket: ${ticket} is not in the correct status to be moved forward`);     
           }
        })
      } else {
        context.logger.error('Jira comment error: config is not valid'); 
      }
    } else {
      context.logger.error('Jira comment error: Jiratransitions does not exists.'); 
    }
    }


    context.logger.info('## end custom jira ticket step');
    await Promise.all([...ticketMoves, ticketComments])
  }