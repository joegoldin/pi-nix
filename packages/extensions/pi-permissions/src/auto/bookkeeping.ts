type BookkeepingKind = "coordination" | "read-only";

/** Recognize a tiny literal grammar, not arbitrary JS. Native codemode still gates each nested tool call. */
export function bookkeepingKind(code: string): BookkeepingKind | undefined {
  if (!code.length || code.length > 8192) return;
  const lexer = /\s+|[A-Za-z_$][\w$]*|[1-9]\d*|"[^"\\\r\n]*"|'[^'\\\r\n]*'|[()[\]{},;.:]/y;
  const tokens: string[] = [];
  let offset = 0;
  while (offset < code.length) {
    lexer.lastIndex = offset;
    const match = lexer.exec(code);
    if (!match) return;
    offset = lexer.lastIndex;
    if (!/^\s+$/.test(match[0])) tokens.push(match[0]);
  }
  let cursor = 0;
  let calls = 0;
  let deletes = false;
  const take = (token: string) => tokens[cursor] === token ? (cursor++, true) : false;
  const sequence = (...parts: string[]) => parts.every(take);
  const positiveId = () => {
    const value = tokens[cursor];
    if (!value || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) return false;
    cursor++;
    return true;
  };
  const unquote = (value: string | undefined) => value && /^["']/.test(value) ? value.slice(1, -1) : value;
  const call = (loop: boolean): boolean => {
    const display = take("text");
    if (display && !take("(")) return false;
    if (!sequence("await", "tools", ".", "todo", "(", "{")) return false;
    let action: string | undefined;
    let id = false;
    const keys = new Set<string>();
    do {
      const raw = tokens[cursor++];
      const key = unquote(raw);
      if (!key || keys.has(key) || !["action", "id"].includes(key)) return false;
      keys.add(key);
      if (key === "action") {
        if (!take(":")) return false;
        const value = tokens[cursor++];
        if (!value || !/^["'](list|get|delete)["']$/.test(value)) return false;
        action = unquote(value);
      } else if (take(":")) {
        id = positiveId() || (loop && take("id"));
        if (!id) return false;
      } else {
        if (!loop || raw !== "id") return false;
        id = true;
      }
    } while (take(","));
    if (!sequence("}", ")") || (display && !take(")"))) return false;
    if (!action || (action === "list" ? id : !id)) return false;
    deletes ||= action === "delete";
    take(";");
    return true;
  };
  while (cursor < tokens.length) {
    if (take(";")) continue;
    if (take("for")) {
      if (!sequence("(", "const", "id", "of", "[")) return;
      let length = 0;
      do { if (!positiveId() || ++length > 128) return; } while (take(","));
      if (!sequence("]", ")")) return;
      const braces = take("{");
      if (!call(true) || (braces && !take("}"))) return;
      calls += length;
    } else {
      if (!call(false)) return;
      calls++;
    }
    if (calls > 256) return;
  }
  return calls ? deletes ? "coordination" : "read-only" : undefined;
}
