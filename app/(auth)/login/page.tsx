import { signIn } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export default function LoginPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <Card className="w-[380px]">
        <CardHeader className="space-y-1 text-center">
          <CardTitle className="text-2xl font-bold">GH Clippy</CardTitle>
          <CardDescription>
            Sign in using your local GitHub CLI session
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            action={async () => {
              'use server';
              await signIn('github-cli', { redirectTo: '/' });
            }}
          >
            <Button type="submit" className="w-full">
              Sign in with GitHub CLI
            </Button>
          </form>
          <p className="mt-3 text-xs text-center text-muted-foreground">
            Requires <code className="bg-muted px-1 rounded">gh auth login</code> to be completed first.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
