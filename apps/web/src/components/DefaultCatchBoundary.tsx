import { type ErrorComponentProps, useRouter } from "@tanstack/react-router";
import { Button } from "@usesend/ui/src/button";

/**
 * The last stop for an error thrown anywhere in a route.
 *
 * It deliberately does not render `error.message`: a server function that
 * throws reaches the client with whatever text the server put on it, and the
 * services behind these routes put database and provider detail in there. The
 * message goes to the console, where a developer can read it and a screenshot
 * in a support ticket cannot.
 */
export function DefaultCatchBoundary({ error, reset }: ErrorComponentProps) {
  const router = useRouter();

  // eslint-disable-next-line no-console
  console.error(error);

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 p-8 text-center">
      <p className="text-2xl font-semibold">Something went wrong</p>
      <p className="max-w-md text-sm text-muted-foreground">
        The page could not be loaded. Retrying is usually enough; if it is not,
        the detail is in the browser console.
      </p>
      <div className="flex gap-2">
        <Button
          variant="outline"
          onClick={() => {
            reset();
            void router.invalidate();
          }}
        >
          Try again
        </Button>
      </div>
    </div>
  );
}
