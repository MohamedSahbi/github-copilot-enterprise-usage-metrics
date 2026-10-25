// Language normalization with parity to upstream src/domain/languageNormalizer.ts (checked by a contract test).

const ALIASES: ReadonlyMap<string, string> = new Map([
  ["c#", "C#"], ["csharp", "C#"], ["c++", "C++"], ["cpp", "C++"],
  ["csv", "CSV"], ["csv (semicolon)", "CSV"], ["csv (pipe)", "CSV"],
  ["python", "Python"], ["py", "Python"], ["javascript", "JavaScript"], ["js", "JavaScript"],
  ["typescript", "TypeScript"], ["ts", "TypeScript"], ["markdown", "Markdown"], ["md", "Markdown"],
  ["terraform", "Terraform"], ["hcl", "Terraform"], ["tf", "Terraform"],
  ["shell", "Shell"], ["sh", "Shell"], ["shellscript", "Shell"],
  ["plantuml", "PlantUML"], ["puml", "PlantUML"], ["wsd", "PlantUML"],
]);

export const LANGUAGE_ALIASES: readonly string[] = [...ALIASES.keys()];

export function normalizeLanguage(raw: string): string {
  const trimmed = raw.trim();
  return ALIASES.get(trimmed.toLowerCase()) ?? trimmed;
}
