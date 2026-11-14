import { groq } from '@ai-sdk/groq';
import { stepCountIs, streamText, type ModelMessage, type ToolSet } from 'ai';
import type { FAST_MODEL_PROVIDER_OPTIONS } from '../config';
import {
  CHAT_TEMPLATE_TOKENS_PER_REQUEST,
  errorMessage,
  logActualUsage,
  logPromptSize,
  SEARCH_TOOL_DEFINITION_TOKENS,
} from './budget';

const FOLLOW_UP_SEARCHES = 1;
const RETRIES_BY_THE_SDK = 0;
export const NO_TOOLS: ToolSet = {};
export const ANSWER_WITHOUT_SEARCHING_AGAIN =
  'You have no searches left this turn. Answer now from the results you already have; do not call any tool.';

export const joinSections = (sections: string[]) => sections.filter(Boolean).join('\n\n');

export type AnswerRequest = {
  modelId: string;
  system: string;
  tools: ToolSet;
  providerOptions?: typeof FAST_MODEL_PROVIDER_OPTIONS;
};

export function streamAnswer(
  answer: AnswerRequest,
  messages: ModelMessage[],
  onFinish: (answerText: string, modelId: string) => void,
) {
  const offersTheSearchTool = Object.keys(answer.tools).length > 0;
  const fixedOverhead = CHAT_TEMPLATE_TOKENS_PER_REQUEST + (offersTheSearchTool ? SEARCH_TOOL_DEFINITION_TOKENS : 0);
  const estimatedBySteps: number[] = [];
  let stepsCounted = 0;
  const callName = (step: number) => `${answer.modelId} answer, step ${step}`;
  return streamText({
    model: groq(answer.modelId),
    providerOptions: answer.providerOptions,
    system: answer.system,
    messages,
    tools: answer.tools,
    maxRetries: RETRIES_BY_THE_SDK,
    stopWhen: stepCountIs(FOLLOW_UP_SEARCHES + 1),
    prepareStep: ({ stepNumber, messages: stepMessages }) => {
      const outOfSearches = stepNumber >= FOLLOW_UP_SEARCHES;
      const stepSystem = outOfSearches ? joinSections([answer.system, ANSWER_WITHOUT_SEARCHING_AGAIN]) : answer.system;
      estimatedBySteps[stepNumber] = logPromptSize(callName(stepNumber + 1), [stepSystem, stepMessages], fixedOverhead);
      return outOfSearches ? { toolChoice: 'none' as const, system: stepSystem } : {};
    },
    onError: ({ error }) => console.error('[agent] model call failed:', errorMessage(error)),
    onStepFinish: (step) => {
      logActualUsage(callName(stepsCounted + 1), estimatedBySteps[stepsCounted] ?? 0, step.usage.inputTokens);
      stepsCounted++;
    },
    onFinish: ({ steps }) => onFinish(steps.map((s) => s.text).join('').trim(), answer.modelId),
  });
}
