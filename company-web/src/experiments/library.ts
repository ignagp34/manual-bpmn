import type { ExperimentLibrary, ProcessCorpusEntry, ProcessPromptDefinition, SystemPromptDefinition } from "./types.js";

const processIndexModules = import.meta.glob("../../prompts/processes/index.json", {
  eager: true,
  import: "default",
}) as Record<string, ProcessCorpusEntry[]>;

const processPromptModules = import.meta.glob("../../prompts/processes/*.md", {
  eager: true,
  import: "default",
  query: "?raw",
}) as Record<string, string>;

const systemPromptModules = import.meta.glob("../../prompts/system/*.md", {
  eager: true,
  import: "default",
  query: "?raw",
}) as Record<string, string>;

export function loadExperimentLibrary(): ExperimentLibrary {
  const processIndex = Object.values(processIndexModules)[0] ?? [];
  const processes: ProcessPromptDefinition[] = processIndex
    .map((entry) => {
      const promptText = lookupProcessPrompt(entry.filename);
      if (promptText === undefined) return null;
      return { ...entry, promptText };
    })
    .filter((entry): entry is ProcessPromptDefinition => entry !== null);

  const systemPrompts = Object.entries(systemPromptModules)
    .map(([path, text]) => makeSystemPrompt(path, text))
    .sort((a, b) => a.label.localeCompare(b.label));

  return {
    corpusAvailable: processIndex.length > 0 && processes.length > 0,
    processes,
    systemPrompts,
  };
}

function lookupProcessPrompt(filename: string): string | undefined {
  const lowerFilename = filename.toLowerCase();
  const match = Object.entries(processPromptModules).find(([path]) =>
    path.toLowerCase().endsWith(`/${lowerFilename}`),
  );
  return match?.[1];
}

function makeSystemPrompt(path: string, text: string): SystemPromptDefinition {
  const filename = path.split("/").pop() ?? path;
  return {
    id: filename,
    label: filename.replace(/\.md$/i, ""),
    text,
    versionHint: deriveSystemVersion(filename),
  };
}

function deriveSystemVersion(filename: string): string {
  const match = filename.match(/v(\d+)[._-]?(\d+)?/i);
  if (match === null) return "SYSv1";
  const major = match[1];
  const minor = match[2] ?? "";
  return `SYSv${major}${minor}`;
}
