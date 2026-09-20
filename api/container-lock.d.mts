export interface ContainerLock {
  lockfileVersion: 3;
  packages: Record<string, {
    resolved?: string;
    integrity?: string;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}

export function publicContainerLock(source: unknown): ContainerLock;
