import { Link } from "@tanstack/react-router";

export function NotFound() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 p-8 text-center">
      <p className="text-2xl font-semibold">Not found</p>
      <p className="text-sm text-muted-foreground">
        That page does not exist.
      </p>
      <Link
        to="/"
        className="text-sm underline decoration-dashed underline-offset-4"
      >
        Back to useSend
      </Link>
    </div>
  );
}
