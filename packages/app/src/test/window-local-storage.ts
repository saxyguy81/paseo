class MemoryLocalStorage {
  private readonly map = new Map<string, string>();

  get length(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }

  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) ?? null) : null;
  }

  key(index: number): string | null {
    return Array.from(this.map.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }

  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

function hasUsableWindowLocalStorage(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return typeof window.localStorage?.setItem === "function";
  } catch {
    return false;
  }
}

if (!hasUsableWindowLocalStorage()) {
  const storage = new MemoryLocalStorage();
  if (typeof window === "undefined") {
    Object.defineProperty(globalThis, "window", {
      value: { localStorage: storage },
      configurable: true,
      writable: true,
    });
  } else {
    Object.defineProperty(window, "localStorage", {
      value: storage,
      configurable: true,
    });
  }
}
