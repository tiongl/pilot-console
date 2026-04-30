import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useAuth } from '../lib/auth-context';
import { Button } from '../../../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../../components/ui/card';
import { ClippyLogo } from '../components/ClippyLogo';

export default function LoginPage() {
  const navigate = useNavigate();
  const { refresh } = useAuth();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleLogin = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/auth/login', { method: 'POST' });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Login failed');
      }
      await refresh();
      navigate('/');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <Card className="w-[380px]">
        <CardHeader className="space-y-1 text-center">
          <ClippyLogo className="h-16 w-16 mx-auto mb-2" />
          <CardTitle className="text-2xl font-bold">Clippy</CardTitle>
          <CardDescription>
            Sign in using your local GitHub CLI session
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button onClick={handleLogin} disabled={loading} className="w-full">
            {loading ? 'Signing in…' : 'Sign in with GitHub CLI'}
          </Button>
          {error && <p className="mt-3 text-sm text-center text-destructive">{error}</p>}
          <p className="mt-3 text-xs text-center text-muted-foreground">
            Requires <code className="bg-muted px-1 rounded">gh auth login</code> to be completed first.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
