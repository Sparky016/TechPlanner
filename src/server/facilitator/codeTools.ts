import { recordAudit } from '@/server/audit/audit';
import { AtlassianApiError, atlassianJson } from '@/server/atlassian/client';
import {
  AzureDevOpsError,
  fileWebUrl,
  getFileContent,
  listDirectory,
  listRepositories,
  MAX_SEARCH_RESULTS,
  searchCode,
} from '@/server/azureDevOps/client';
import type { LlmToolDefinition } from '@/server/llm';
import { buildCodeFindingsNodes, CODE_BLOCK_END, CODE_BLOCK_START, upsertDelimitedBlock, type AdfDoc } from '@/server/publish/adf';
import type { FacilitatorTurnState } from './tools';
import { attr, neutralise, UNTRUSTED_TAG } from './untrusted';

// Server-only: never import from src/lib or client components.
// Code investigation tools (ADR-0016): read-only Azure DevOps Repos access, plus one Jira write that upserts a
// delimited "Code investigation" block in a session ticket's description as the acting user. Offered only when
// Azure DevOps is configured. Repository content is untrusted data (LLM-6) and is returned inside delimited blocks.

/** Repository reads (list, search, read, list directory) per turn, so one turn cannot crawl a repository. */
export const MAX_CODE_CALLS_PER_TURN = 25;
export const CODE_CALL_LIMIT_MESSAGE = 'Code investigation limit reached for this turn';
export const FINDINGS_SUMMARY_MAX = 10_000;
export const MAX_FINDINGS_REFERENCES = 30;

const SEARCH_TEXT_MAX = 500;
const PATH_MAX = 1_000;
const REPOSITORY_PATTERN = '^[^/\\\\?#%]{1,256}$';
const BRANCH_PATTERN = '^[A-Za-z0-9._/-]{1,250}$';
const ISSUE_KEY_PATTERN = '^[A-Z][A-Z0-9_]+-[1-9][0-9]*$';

interface SearchCodeArgs {
  text: string;
  repository?: string;
}

interface ReadFileArgs {
  repository: string;
  path: string;
  branch?: string;
}

interface UpdateTicketArgs {
  ticketKey: string;
  summary: string;
  references?: { repository: string; path: string; branch?: string }[];
}

function untrusted(kind: string, ref: string, body: string): string {
  return `<${UNTRUSTED_TAG} kind="${kind}" ref="${attr(ref)}">\n${neutralise(body)}\n</${UNTRUSTED_TAG}>`;
}

/** Counts one repository read; returns the limit message once the turn's budget is spent. */
function overBudget(state: FacilitatorTurnState): string | null {
  if (state.codeCalls >= MAX_CODE_CALLS_PER_TURN) return CODE_CALL_LIMIT_MESSAGE;
  state.codeCalls++;
  return null;
}

/** Azure DevOps failures go back to the model as a result, so it can adjust the next call. */
async function adoResult(run: () => Promise<string>): Promise<string> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof AzureDevOpsError) return `Azure DevOps error (${err.code}): ${err.message}`;
    throw err;
  }
}

const repositoryProp = { type: 'string', pattern: REPOSITORY_PATTERN } as const;
const branchProp = { type: 'string', pattern: BRANCH_PATTERN } as const;
const pathProp = { type: 'string', minLength: 1, maxLength: PATH_MAX } as const;

function listRepositoriesTool(state: FacilitatorTurnState): LlmToolDefinition {
  return {
    name: 'list_repositories',
    description: 'List the Azure DevOps repositories available for code investigation, with their default branches.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    handler: async () => {
      const limited = overBudget(state);
      if (limited) return limited;
      return adoResult(async () => {
        const repos = await listRepositories();
        if (repos.length === 0) return 'No repositories are available.';
        return repos.map((r) => `- ${r.name} (default branch: ${r.defaultBranch ?? 'none'})`).join('\n');
      });
    },
  };
}

function searchCodeTool(state: FacilitatorTurnState): LlmToolDefinition {
  return {
    name: 'search_code',
    description: `Search code in the Azure DevOps repositories (Azure DevOps Code Search syntax, e.g. "RefundService", "ext:cs Refund", "path:/src/api"). Optionally limit to one repository. Returns up to ${MAX_SEARCH_RESULTS} matching files; read them with read_code_file.`,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['text'],
      properties: { text: { type: 'string', minLength: 1, maxLength: SEARCH_TEXT_MAX }, repository: repositoryProp },
    },
    handler: async (args) => {
      const { text, repository } = args as SearchCodeArgs;
      const limited = overBudget(state);
      if (limited) return limited;
      return adoResult(async () => {
        const { total, hits } = await searchCode(text, { repository });
        if (hits.length === 0) return `No matches for "${text}".`;
        const lines = hits.map(
          (h) => `- ${h.repository}:${h.path}${h.branch ? ` @${h.branch}` : ''} (${h.matchCount} match${h.matchCount === 1 ? '' : 'es'})`,
        );
        const more = total > hits.length ? `\n(${total - hits.length} more files match; refine the search)` : '';
        return `${hits.length} of ${total} matching files:\n${lines.join('\n')}${more}`;
      });
    },
  };
}

function readCodeFileTool(state: FacilitatorTurnState): LlmToolDefinition {
  return {
    name: 'read_code_file',
    description: 'Read one file from an Azure DevOps repository. Omit branch to use the default branch.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['repository', 'path'],
      properties: { repository: repositoryProp, path: pathProp, branch: branchProp },
    },
    handler: async (args) => {
      const { repository, path, branch } = args as ReadFileArgs;
      const limited = overBudget(state);
      if (limited) return limited;
      return adoResult(async () => {
        const file = await getFileContent(repository, path, branch);
        const ref = `${file.repository}:${file.path}${file.branch ? `@${file.branch}` : ''}`;
        if (file.binary) return `${ref} is a binary file; its content is not shown.`;
        const body = file.truncated ? `${file.content}\n[... truncated: file exceeds the read limit]` : file.content;
        return untrusted('code', ref, body);
      });
    },
  };
}

function listCodeDirectoryTool(state: FacilitatorTurnState): LlmToolDefinition {
  return {
    name: 'list_code_directory',
    description: 'List the files and folders directly inside one folder of an Azure DevOps repository ("/" for the root).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['repository', 'path'],
      properties: { repository: repositoryProp, path: pathProp, branch: branchProp },
    },
    handler: async (args) => {
      const { repository, path, branch } = args as ReadFileArgs;
      const limited = overBudget(state);
      if (limited) return limited;
      return adoResult(async () => {
        const entries = await listDirectory(repository, path, branch);
        if (entries.length === 0) return `${repository}:${path} is empty or does not exist.`;
        return entries.map((e) => `- ${e.path}${e.isFolder ? '/' : ''}`).join('\n');
      });
    },
  };
}

function issuePath(key: string): string {
  return `/rest/api/3/issue/${encodeURIComponent(key)}`;
}

function updateTicketTool(state: FacilitatorTurnState): LlmToolDefinition {
  return {
    name: 'update_ticket_code_findings',
    description:
      "Write your code investigation findings to one session ticket's Jira description, in a block Tech Planner manages (it replaces the previous findings block; the rest of the description is untouched). Only call this when the facilitator asked for, or agreed to, the ticket update.",
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['ticketKey', 'summary'],
      properties: {
        ticketKey: { type: 'string', pattern: ISSUE_KEY_PATTERN },
        summary: { type: 'string', minLength: 1, maxLength: FINDINGS_SUMMARY_MAX },
        references: {
          type: 'array',
          maxItems: MAX_FINDINGS_REFERENCES,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['repository', 'path'],
            properties: { repository: repositoryProp, path: pathProp, branch: branchProp },
          },
        },
      },
    },
    handler: async (args) => {
      const { ticketKey, summary, references = [] } = args as UpdateTicketArgs;
      const user = state.user;
      if (!user) return 'Ticket updates are not available in this turn';
      if (!state.ticketKeys.includes(ticketKey)) {
        return `${ticketKey} is not a ticket of this session (${state.ticketKeys.join(', ')})`;
      }
      const nodes = buildCodeFindingsNodes({
        summary,
        references: references.map((r) => ({
          repository: r.repository,
          path: r.path,
          url: fileWebUrl(r.repository, r.path, r.branch),
        })),
        author: user.displayName,
        updatedAt: new Date(),
      });

      let errorCode: string | undefined;
      try {
        const issue = await atlassianJson<{ fields?: { description?: AdfDoc | null } }>(
          user.accountId,
          'jira',
          `${issuePath(ticketKey)}?fields=description`,
        );
        const description = upsertDelimitedBlock(issue.fields?.description ?? null, nodes, CODE_BLOCK_START, CODE_BLOCK_END);
        await atlassianJson(user.accountId, 'jira', issuePath(ticketKey), {
          method: 'PUT',
          body: JSON.stringify({ fields: { description } }),
        });
      } catch (err) {
        errorCode = err instanceof AtlassianApiError ? err.code : 'jira_update_failed';
        throw err;
      } finally {
        state.ticketUpdates.push({ ticketKey, result: errorCode ? 'failure' : 'success' });
        await recordAudit({
          action: 'jira.updated',
          result: errorCode ? 'failure' : 'success',
          userId: user.accountId,
          userDisplayName: user.displayName,
          sessionId: state.sessionId,
          ticketIds: [ticketKey],
          details: {
            step: 'code_findings',
            references: references.length,
            ...(errorCode ? { errorCode } : {}),
          },
        });
      }
      return `Updated the code investigation block on ${ticketKey}`;
    },
  };
}

export function createCodeTools(state: FacilitatorTurnState): LlmToolDefinition[] {
  return [
    listRepositoriesTool(state),
    searchCodeTool(state),
    readCodeFileTool(state),
    listCodeDirectoryTool(state),
    ...(state.user ? [updateTicketTool(state)] : []),
  ];
}
