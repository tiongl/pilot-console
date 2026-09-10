import { describe, expect, it, vi, beforeEach } from 'vitest';
import path from 'path';

const mocked = vi.hoisted(() => ({
  spawn: vi.fn(() => ({ unref: vi.fn() })),
}));

vi.mock('child_process', () => ({
  default: {
    spawn: mocked.spawn,
  },
  spawn: mocked.spawn,
}));

import { getRevealCommand, revealPathInFileSystem } from '../server/file-system';

describe('file system reveal helpers', () => {
  beforeEach(() => {
    mocked.spawn.mockClear();
  });

  it('builds the platform-specific reveal command', () => {
    const resolvedUnix = path.resolve('/repo/file.txt');
    expect(getRevealCommand('C:\\repo\\file.txt', 'win32')).toEqual({
      command: 'explorer.exe',
      args: ['/select,C:\\repo\\file.txt'],
    });
    expect(getRevealCommand('/repo/file.txt', 'darwin')).toEqual({
      command: 'open',
      args: ['-R', resolvedUnix],
    });
    expect(getRevealCommand('/repo/file.txt', 'linux')).toEqual({
      command: 'xdg-open',
      args: [path.dirname(resolvedUnix)],
    });
  });

  it('spawns the reveal command detached', () => {
    const resolvedUnix = path.resolve('/repo/file.txt');
    revealPathInFileSystem('/repo/file.txt', 'linux');

    expect(mocked.spawn).toHaveBeenCalledWith('xdg-open', [path.dirname(resolvedUnix)], expect.objectContaining({
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    }));
  });
});
