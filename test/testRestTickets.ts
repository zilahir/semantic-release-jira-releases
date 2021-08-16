import JiraClient from 'jira-connector';

export function makeClient(): JiraClient {
    return new JiraClient({
      host: '',
      basic_auth: {
        base64: '',
      },
    });
}

const jira = makeClient();

async function getTicketsForColumn() {
    const tickets = await jira.search.search({ jql: "project='VACCA' AND type IN ('Bug', 'Task') AND status = 'Production ready' "});
    console.log(tickets)
}

getTicketsForColumn()

