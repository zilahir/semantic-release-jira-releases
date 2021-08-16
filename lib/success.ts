import JiraClient, { Config, Version } from 'jira-connector';
// import * as _ from 'lodash';
import { filter, find, template } from 'lodash';
import pLimit from 'p-limit';
import { moveJiraTickets } from './generateNotes';

import { makeClient } from './jira';
import { DEFAULT_RELEASE_DESCRIPTION_TEMPLATE, DEFAULT_VERSION_TEMPLATE, GenerateNotesContext, PluginConfig } from './types';
import { escapeRegExp } from './util';

const dailyVersionRegexp = new RegExp(/\[DAILY\].*Account/)

export function getTickets(config: PluginConfig, context: GenerateNotesContext): string[] {
  let patterns: RegExp[] = [];

  if (config.ticketRegex !== undefined) {
    patterns = [new RegExp(config.ticketRegex, 'giu')];
  } else {
    patterns = config.ticketPrefixes!
        .map(prefix => new RegExp(`\\b${escapeRegExp(prefix)}-(\\d+)\\b`, 'giu'));
  }

  const tickets = new Set<string>();
  for (const commit of context.commits) {
    for (const pattern of patterns) {
      const matches = commit.message.match(pattern);
      if (matches) {
        matches.forEach(match => {
          tickets.add(match);
          context.logger.info(`Found ticket ${matches} in commit: ${commit.commit.short}`);
        });
      }
    }
  }

  return [...tickets];
}

async function findOrCreateVersion(config: PluginConfig, context: GenerateNotesContext, jira: JiraClient, projectIdOrKey: string, name: string, description: string): Promise<Version | undefined> {
  const remoteVersions = await jira.project.getVersions({ projectIdOrKey });
  context.logger.info(`Looking for version with name '${name}'`);
  const existing = find(remoteVersions, { name });
  if (existing) {
    context.logger.info(`Found existing release '${existing.id}'`);
    return existing;
  }

  context.logger.info(`No existing release found, creating new`);

  let newVersion: Version;
  if (config.dryRun) {
    context.logger.info(`dry-run: making a fake release`);
    return newVersion = {
      name,
      id: 'dry_run_id',
    } as any;
  } else {
    const descriptionText = description || '';
    context.logger.info(`Attempting to create a release on project: ${projectIdOrKey}`)
    try {
      newVersion = await jira.version.createVersion({
        name,
        projectId: projectIdOrKey as any,
        description: descriptionText,
        released: Boolean(config.released),
        releaseDate: config.setReleaseDate ? (new Date().toISOString()) : undefined,
      });

      context.logger.info(`Made new release '${newVersion.id}'`);
      return newVersion;

    } catch(err) {
      context.logger.error(`Error while creating Jira release: ${JSON.stringify(err)}`);
    }
  }
  return undefined;
}

async function editIssueFixVersions(config: PluginConfig, context: GenerateNotesContext, jira: JiraClient, newVersionName: string, releaseVersionId: string, issueKey: string): Promise<void> {
  try {
    context.logger.info(`Adding issue ${issueKey} to '${newVersionName}'`);
    if (!config.dryRun) {
      await jira.issue.editIssue({
        issueKey,
        issue: {
          update: {
            fixVersions: [{
              add: { id: releaseVersionId },
            }],
          },
          properties: undefined as any,
        },
      });
    }
  } catch (err) {
    const allowedStatusCodes = [400, 404];
    let { statusCode } = err;
    if (typeof err === 'string') {
      try {
        err = JSON.parse(err);
        statusCode = statusCode || err.statusCode;
      } catch (err) {
          // it's not json :shrug:
      }
    }
    if (allowedStatusCodes.indexOf(statusCode) === -1) {
      throw err;
    }
    context.logger.error(`Unable to update issue ${issueKey} statusCode: ${statusCode}`);
  }
}

async function editPreReleases(jira: JiraClient, projectIdOrKey: string, context: GenerateNotesContext, config: PluginConfig): Promise<any>{
  const remoteVersions: Array<any> = await jira.project.getVersions({ projectIdOrKey })
  const unReleasedPreReleases = filter(remoteVersions, (release) => !release.released && !release.archived && release.name.match(dailyVersionRegexp))
  console.log('unReleasedPreReleases', unReleasedPreReleases)

  const releases = unReleasedPreReleases.map((release) => {
    context.logger.info(`Setting release ${release.name} to RELEASED'`);
      if (!config.dryRun) {
        try {
          jira.version.editVersion({
            versionId: release.id,
            version: {
                released: Boolean(true),
                releaseDate: new Date().toISOString(),
            }
          })
        } catch (err) {
          context.logger.error(`Erorr while setting release to released state: ${JSON.stringify(err)}`)
        }
      }
  })

  await Promise.all(releases)
}

async function moveTicketToReleased(jira: JiraClient, context: GenerateNotesContext, config: PluginConfig) {
  if (!config.dryRun) {
    const jiraIssues = await jira.search.search({ jql: "project='VACCA' AND type IN ('Bug', 'Task') AND status = 'Production ready' "});
    const tickets = jiraIssues.issues.map(t => t.id)
    const targetState = config.jiraTransitions!['release'].targetState
    const transitions = tickets.map(ticket => {
      if (!config.dryRun) {
        try {
          moveJiraTickets(ticket, jira, context, targetState.toString())
        } catch(error) {
          context.logger.error(`Error moving ticket: ${ticket}. Error: ${JSON.stringify(error)}`)
        }
      }
    })
    await Promise.all(transitions)
  }
}


export async function success(config: PluginConfig, context: GenerateNotesContext): Promise<void> {
  const tickets = getTickets(config, context);
  const jira = makeClient(config, context);

  context.logger.info(`Found ticket ${tickets.join(', ')}`);

  // @ts-ignore
  const currentBranch = context.envCi.branch

  let stage
  if (currentBranch) {
    if (currentBranch === 'master') {
      stage = 'PRODUCTION'
    } else if (currentBranch === 'daily') {
      stage = 'DAILY'
    }
  }

  const versionTemplate = template(config.releaseNameTemplate ?? DEFAULT_VERSION_TEMPLATE);
  const newVersionName = versionTemplate({ version: context.nextRelease.version, stage });

  const descriptionTemplate = template(config.releaseDescriptionTemplate ?? DEFAULT_RELEASE_DESCRIPTION_TEMPLATE);
  const newVersionDescription = descriptionTemplate({ version: context.nextRelease.version, notes: context.nextRelease.notes });

  context.logger.info(`Using jira release '${newVersionName}'`);

  const project = await jira.project.getProject({ projectIdOrKey: config.projectId });
  context.logger.info(`Found Jira Project '${JSON.stringify(project)}'`);
  const releaseVersion = await findOrCreateVersion(config, context, jira, project.id, newVersionName, newVersionDescription);

  const concurrentLimit = pLimit(config.networkConcurrency || 10);

  if (releaseVersion && stage === 'PRODUCTION') {
    // here we need to set the previous _unreleased_ pre-releases_ to released
    context.logger.info('editing releases');
    await editPreReleases(jira, project.id, context, config)
    context.logger.info('editing releases DONE');

    // these are tickets being in production ready which doesnt belong to any commits
    context.logger.info('moving tickets without commits');
    await moveTicketToReleased(jira, context, config)
    context.logger.info('moving tickets without commits DONE');
  }

  const edits = tickets.map(issueKey =>
    concurrentLimit(() => {
      if (releaseVersion) {
        editIssueFixVersions(config, context, jira, newVersionName, releaseVersion.id, issueKey)
      }
    }),
  );

  await Promise.all(edits);
}
