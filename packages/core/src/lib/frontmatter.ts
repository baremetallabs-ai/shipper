export interface PromptFrontmatter {
  cmd: string;
  args: string[];
  'append-issue'?: boolean;
  'append-pr'?: boolean;
}

export interface ParsedPrompt {
  frontmatter: PromptFrontmatter;
  body: string;
}

function stripQuotes(s: string): string {
  if (s.length >= 2) {
    const first = s[0];
    const last = s[s.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return s.slice(1, -1);
    }
  }
  return s;
}

export function parseFrontmatter(raw: string): ParsedPrompt {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) {
    throw new Error('Prompt file is missing frontmatter (expected --- delimiters)');
  }

  const [, yamlBlock, body] = match as [string, string, string];
  const frontmatter: PromptFrontmatter = { cmd: '', args: [] };

  let currentKey: string | null = null;
  let inArray = false;

  for (const line of yamlBlock.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    // Array item: "  - value"
    if (inArray && trimmed.startsWith('- ')) {
      const value = stripQuotes(trimmed.slice(2).trim());
      if (currentKey === 'args') {
        frontmatter.args.push(value);
      }
      continue;
    }

    // Key-value pair: "key: value"
    const kvMatch = trimmed.match(/^([a-z][a-z0-9-]*)\s*:\s*(.*)$/);
    if (!kvMatch) continue;

    const [, key, rawValue] = kvMatch as [string, string, string];
    const value = stripQuotes(rawValue.trim());
    currentKey = key;

    if (value === '') {
      // Next lines are array items
      inArray = key === 'args';
      continue;
    }

    inArray = false;

    if (key === 'cmd') {
      frontmatter.cmd = value;
    } else if (key === 'append-issue' || key === 'append-pr') {
      frontmatter[key] = value === 'true';
    }
  }

  if (!frontmatter.cmd) {
    throw new Error('Prompt frontmatter is missing required "cmd" field');
  }

  return { frontmatter, body: body.trimStart() };
}
