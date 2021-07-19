import { has } from 'lodash';
import { GenerateNotesContext, JiraTransitions } from './types';

export function escapeRegExp(strIn: string): string {
  return strIn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function validateJiraTransitionConfig(transitionConfig: JiraTransitions, branchName: string, context: GenerateNotesContext):boolean {
  const isBranchInConfig = Object.keys(transitionConfig).some((branch: string) => branch === branchName)
  if (!isBranchInConfig) {
    context.logger.error(`Branch config for ${branchName} is missing in transitionConfig`);
    return false
  }
  const thisBranchConfig = transitionConfig[branchName]
  if (!has(thisBranchConfig, 'originState') && !has(thisBranchConfig, 'targetState')) {
    context.logger.error(`Either originState or targetState is missing in ${branchName} object from transitionConfig`);
    return false
  }
  context.logger.info('Jira transition setup is correct!');
  return true
}