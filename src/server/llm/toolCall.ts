import Ajv, { type ValidateFunction } from 'ajv';
import type { LlmToolDefinition } from './types';

// Server-only: never import from src/lib or client components.
// Shared by CopilotLlmClient and FakeLlmClient so both validate tool arguments identically (LLM-5).

// strict:false so schemas carrying annotation keywords from tasks 23/24 still compile.
const ajv = new Ajv({ strict: false, allErrors: true });
const validators = new WeakMap<LlmToolDefinition, ValidateFunction>();

function validatorFor(tool: LlmToolDefinition): ValidateFunction {
  let validate = validators.get(tool);
  if (!validate) {
    validate = ajv.compile(tool.parameters as object);
    validators.set(tool, validate);
  }
  return validate;
}

export interface ToolCallOutcome {
  /** Message returned to the model. */
  result: string;
  /** False when validation failed or the handler threw; the handler is not called on invalid arguments. */
  ok: boolean;
}

export async function executeToolCall(tool: LlmToolDefinition, args: unknown): Promise<ToolCallOutcome> {
  let validate: ValidateFunction;
  try {
    validate = validatorFor(tool);
  } catch {
    return { result: `Tool ${tool.name} is unavailable: invalid parameter schema`, ok: false };
  }
  if (!validate(args)) {
    return { result: `Invalid arguments: ${ajv.errorsText(validate.errors)}`, ok: false };
  }
  try {
    return { result: await tool.handler(args), ok: true };
  } catch (err) {
    return { result: `Tool ${tool.name} failed: ${err instanceof Error ? err.message : 'unknown error'}`, ok: false };
  }
}
