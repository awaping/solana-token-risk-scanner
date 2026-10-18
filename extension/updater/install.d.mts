/** Types de install.mjs (installation de l'assistant de mise à jour). */
export declare const HOST_NAME: string;
export declare function extensionIdFromKey(key: string): string;
export declare function hostManifest(
  launcher: string,
  extensionId: string,
): { name: string; description: string; path: string; type: 'stdio'; allowed_origins: string[] };
