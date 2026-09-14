import { describe, expect, it } from 'vitest';
import { parseLavishSessionUrl } from '../shared/lavish-runtime';

describe('parseLavishSessionUrl', () => {
  it('parses the YAML url line lavish-axi prints', () => {
    const stdout = [
      'session:',
      '  file: "C:\\\\tmp\\\\artifact.html"',
      '  url: "http://garage-pc.tail6adca2.ts.net:4387/session/b928d8140c4403b5"',
      '  status: opened',
    ].join('\n');

    const parsed = parseLavishSessionUrl(stdout);
    expect(parsed).not.toBeNull();
    expect(parsed!.host).toBe('garage-pc.tail6adca2.ts.net');
    expect(parsed!.port).toBe(4387);
    expect(parsed!.sessionKey).toBe('b928d8140c4403b5');
    expect(parsed!.sessionUrl).toBe(
      'http://garage-pc.tail6adca2.ts.net:4387/session/b928d8140c4403b5',
    );
  });

  it('parses a plain 127.0.0.1 url without quotes', () => {
    const parsed = parseLavishSessionUrl('url: http://127.0.0.1:5000/session/deadbeef');
    expect(parsed).toEqual({
      sessionUrl: 'http://127.0.0.1:5000/session/deadbeef',
      host: '127.0.0.1',
      port: 5000,
      sessionKey: 'deadbeef',
    });
  });

  it('returns null when no session url has been printed yet', () => {
    expect(parseLavishSessionUrl('booting lavish daemon...')).toBeNull();
  });
});
