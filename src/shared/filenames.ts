export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : '';
}

/** Makes names unique inside one archive: "a.txt", "a (2).txt", ... */
export function uniqueNames(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((name) => {
    const count = (seen.get(name) ?? 0) + 1;
    seen.set(name, count);
    if (count === 1) return name;
    const ext = extensionOf(name);
    const stem = ext ? name.slice(0, -(ext.length + 1)) : name;
    return `${stem} (${count})${ext ? `.${ext}` : ''}`;
  });
}
