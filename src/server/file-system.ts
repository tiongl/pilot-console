import path from 'path';
import { spawn } from 'child_process';

export interface RevealCommand {
  command: string;
  args: string[];
}

export function getRevealCommand(targetPath: string, platform = process.platform): RevealCommand {
  const resolvedPath = path.resolve(targetPath);

  if (platform === 'win32') {
    return { command: 'explorer.exe', args: ['/select,' + resolvedPath] };
  }

  if (platform === 'darwin') {
    return { command: 'open', args: ['-R', resolvedPath] };
  }

  return { command: 'xdg-open', args: [path.dirname(resolvedPath)] };
}

export function revealPathInFileSystem(targetPath: string, platform = process.platform): void {
  const { command, args } = getRevealCommand(targetPath, platform);
  const child = spawn(command, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
}
