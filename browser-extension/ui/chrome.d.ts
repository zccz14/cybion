// 扩展页里 `chrome` 由浏览器注入；这里只声明用到的部分，省掉 @types/chrome 的版本漂移。
declare const chrome: {
  runtime: {
    sendMessage(message: unknown): Promise<any>
    onMessage: {
      addListener(listener: (message: any, sender: any, respond: (value?: any) => void) => boolean | void): void
    }
  }
  tabs: {
    query(query: Record<string, unknown>): Promise<any[]>
    sendMessage(tabId: number, message: unknown): Promise<any>
    create(props: { url: string }): Promise<any>
  }
  storage: {
    local: {
      get(key: string): Promise<Record<string, any>>
      set(items: Record<string, unknown>): Promise<void>
      remove(key: string): Promise<void>
    }
    onChanged: {
      addListener(listener: (changes: Record<string, { newValue?: any; oldValue?: any }>) => void): void
      removeListener(listener: (changes: Record<string, { newValue?: any; oldValue?: any }>) => void): void
    }
  }
}
