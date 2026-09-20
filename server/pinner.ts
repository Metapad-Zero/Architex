/** Somewhere that keeps a file available on IPFS. The service decides nothing: we tell it the bytes and check the address it reports. */
export interface PinnedFile {
  /** The service's own handle for the file, needed to remove it again. */
  id: string
  cid: string
}

export interface FileToPin {
  bytes: Uint8Array
  name: string
  type: string
  /** Labels stored beside the file, so our uploads can be told apart and cleaned up. */
  labels: Record<string, string>
}

export interface Pinner {
  pin(file: FileToPin): Promise<PinnedFile>
  unpin(id: string): Promise<void>
}
