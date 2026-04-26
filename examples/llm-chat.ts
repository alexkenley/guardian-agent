/**
 * LLM Chat Example — Simple provider demo.
 *
 * Demonstrates direct use of the LLM provider abstraction
 * without the full runtime. Uses Ollama by default.
 *
 * Run: npx tsx examples/llm-chat.ts
 */

import { createProvider } from '../src/llm/provider.js';
import type { ChatMessage } from '../src/llm/types.js';

async function main(): Promise<void> {
  console.log('=== GuardianAgent LLM Chat Example ===\n');

  // Create an Ollama provider (no API key needed)
  const provider = createProvider({
    provider: 'ollama',
    model: 'gpt-oss:120b',
    baseUrl: 'http://127.0.0.1:11434',
  });

  // List available models
  console.log('Available models:');
  const models = await provider.listModels();
  if (models.length === 0) {
    console.log('  (no models found — is Ollama running?)\n');
  } else {
    for (const model of models) {
      console.log(`  - ${model.id}`);
    }
    console.log();
  }

  // Chat completion
  const messages: ChatMessage[] = [
    { role: 'system', content: 'You are a helpful assistant. Keep responses brief.' },
    { role: 'user', content: 'What is the capital of France?' },
  ];

  console.log('Sending chat request...');
  try {
    const response = await provider.chat(messages);
    console.log(`\nModel: ${response.model}`);
    console.log(`Response: ${response.content}`);
    if (response.usage) {
      console.log(`Tokens: ${response.usage.promptTokens} prompt + ${response.usage.completionTokens} completion = ${response.usage.totalTokens} total`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`\nError: ${msg}`);
    console.log('Make sure Ollama is running: ollama serve');
  }

  console.log('\n=== Done ===');
}

main().catch(console.error);
