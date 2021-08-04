import JiraClient from 'jira-connector';
import { filter } from 'lodash';

const JIRA_VACCA_PROJECT_ID = 10054

// const dailyVersionRegexp = new RegExp(/\[DAILY\].*Account/)

const SEMANTIC_TEST_REGEXP = new RegExp(/SEMANTIC_TEST/)

export function makeClient(): JiraClient {
    return new JiraClient({
      host: '',
      basic_auth: {
        base64: '',
      },
    });
}

const jira = makeClient();

async function testPreReleases() {
    const remoteVersions: Array<any> = await jira.project.getVersions({ projectIdOrKey: JIRA_VACCA_PROJECT_ID })
    const unReleasedPreReleases = filter(remoteVersions, (release) => !release.released && !release.archived && release.name.match(SEMANTIC_TEST_REGEXP))
    console.log('unReleasedPreReleases', unReleasedPreReleases)

    const releases = unReleasedPreReleases.map((release) => {
        jira.version.editVersion({
            versionId: release.id,
            version: {
                released: Boolean(true),
                releaseDate: new Date().toISOString(),
            }
        })
    })

    await Promise.all(releases)
}

testPreReleases()