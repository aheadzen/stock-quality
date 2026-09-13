// Web search tool definition for MiniMax function calling.
// Many MiniMax-compatible endpoints either:
//   (a) execute web search server-side and return content inline, OR
//   (b) return tool_calls for the client to dispatch.
// The runToolLoop helper in evaluator.js handles both shapes.

export const webSearchTool = {
  type: 'function',
  function: {
    name: 'web_search',
    description:
      'Search the public web for current information. Use this to look up stock prices, financial fundamentals, news, or any other fact you need to answer the user.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query to run.',
        },
      },
      required: ['query'],
    },
  },
};

export const TOOL_CHOICE = 'auto';

export const TOOLS = [webSearchTool];