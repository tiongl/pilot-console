import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

interface GitHubProfile {
  id: number;
  login: string;
  name: string | null;
  email: string | null;
  avatar_url: string;
}

export async function getGitHubCliProfile(): Promise<GitHubProfile | null> {
  try {
    const { stdout } = await execFileAsync('gh', ['auth', 'token'], {
      timeout: 5000,
    });
    const token = stdout.trim();
    if (!token) return null;

    const res = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
      },
    });

    if (!res.ok) return null;
    return (await res.json()) as GitHubProfile;
  } catch {
    return null;
  }
}
