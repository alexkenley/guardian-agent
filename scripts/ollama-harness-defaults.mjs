export const DEFAULT_HARNESS_OLLAMA_MODEL = 'gemma4:26b';

function normalizeModelName(value) {
  return String(value || '').trim().toLowerCase();
}

function listAvailableModelNames(models) {
  return (Array.isArray(models) ? models : [])
    .map((model) => String(model?.name || '').trim())
    .filter(Boolean);
}

export function resolveHarnessOllamaModel(configuredModel, models) {
  const availableModels = listAvailableModelNames(models);
  const requestedModel = String(configuredModel || '').trim();

  if (requestedModel) {
    const requested = normalizeModelName(requestedModel);
    if (!availableModels.some((name) => normalizeModelName(name) === requested)) {
      throw new Error(
        [
          `Configured HARNESS_OLLAMA_MODEL=${requestedModel} is not installed.`,
          availableModels.length
            ? `Available models: ${availableModels.join(', ')}.`
            : 'No models are currently installed.',
        ].join(' '),
      );
    }
    return requestedModel;
  }

  const preferred = availableModels.find(
    (name) => normalizeModelName(name) === normalizeModelName(DEFAULT_HARNESS_OLLAMA_MODEL),
  );
  if (preferred) {
    return preferred;
  }

  return availableModels[0] || '';
}
