# Aidelix hosted plugin

The AIT-246 package prepares Aidelix for OpenAI plugin distribution. A package
in Git does not establish a public listing or a working hosted connection.
Record the account test before you mark a distribution complete.

The server is `https://api.aidelix.com/v1/mcp`. It uses browser sign-in through
OAuth, a protocol that gives access after consent. The server supports
client registration, token refresh, and revocation. No local Node process or
manual agent key is part of the Codex plugin.

## Test the package locally

Use a recent Codex client that supports plugin MCP declarations in its manifest.
Clone the branch that contains AIT-246 before the steps below. Run the tests
from the repository root.

1. Run `npm ci`.
2. Run `npm test`.
3. Run `codex plugin marketplace add /absolute/path/to/skills` with your checkout path.
4. Run `codex plugin add aidelix@aidelix-skills`.
5. Connect the plugin account through browser sign-in.
6. Start a new session.
7. Ask the agent to list your Aidelix projects.

Do not add the direct server as well as the plugin server. If both exist,
choose one connection before removing the duplicate. The Claude bridge is
separate and retains its existing channel behavior.

## Publish to a workspace

A workspace administrator performs this step. Use the reviewed package
revision and follow [OpenAI plugin management](https://developers.openai.com/plugins/build/plugins).
Workspace publication does not publish a public directory listing.

1. Import the `aidelix/skills` GitHub marketplace in Admin > Plugins, where that control is available.
2. Select the reviewed source revision that contains AIT-246.
3. Make Aidelix available to the intended workspace roles.
4. Install Aidelix from the workspace section of Plugins.
5. Connect its account and allow access in Aidelix.
6. Start a new hosted task.
7. Ask the agent to list your Aidelix projects.

If your workspace uses personal plugin sharing instead of GitHub import,
open the installed plugin under Personal and select Publish. Choose the
workspace roles that can use it. An admin can disable this capability.
Use the [current publication guide](https://developers.openai.com/plugins/build/plugins)
if the account has different controls.

Record the tested client, package revision, account type, and project-list
result on AIT-246. Never include tokens. A successful local test does not
substitute for this hosted test.

## Submit a public plugin

Use the [OpenAI submission portal workflow](https://developers.openai.com/plugins/deploy/submission)
for public distribution. Public publication requires review. Prepare the
reviewed package, publisher details, policy links, and reviewer access as
required by that workflow.

Select the remote HTTPS MCP path and supply
`https://api.aidelix.com/v1/mcp`. Test browser sign-in and the project-list
request in the submission environment. Publish an install link in Aidelix
only after OpenAI returns a working listing.

The package targets production. A self-hosted instance requires its own
endpoint and distribution configuration. Do not silently send its users to
production.

## Cloud boundaries

Claude Code Cloud uses authenticated Claude account connectors. Add the
Aidelix endpoint at [Claude connectors](https://claude.ai/customize/connectors).
Organization policy can restrict this path. The local Claude bridge and its
channel do not configure it.

Current Codex cloud environments support network secrets for HTTPS requests.
That supplies a possible shell fallback, not native MCP tool discovery.
The fallback needs its own test in the target environment.

Legacy Codex Cloud secrets exist only during setup. Do not copy credentials
into cached files to retain them. Local `.codex/config.toml` and local
marketplace installation do not establish hosted access.

Sources: [OpenAI MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli),
[current cloud environments](https://learn.chatgpt.com/docs/environments/cloud-environments),
[legacy cloud environments](https://learn.chatgpt.com/docs/environments/cloud-environment),
and [Claude MCP](https://code.claude.com/docs/en/mcp).
