import { H1 } from "@usesend/ui";

/**
 * Placeholder for a dashboard area that has not moved off Next.js yet (#9).
 *
 * The route tree lands complete in one go so the sidebar, the layout and every
 * link are real from the start and only have to be got right once. The pages
 * arrive one PR at a time, and each one deletes its placeholder — so the count
 * of files importing this is the amount of Phase 7 left.
 *
 * It says which area and where the working version still is, because during
 * the migration "this page is blank" and "this page has not moved yet" are
 * different problems and only one of them is a bug.
 */
export function NotPortedYet({ area }: { area: string }) {
  return (
    <div>
      <H1>{area}</H1>
      <div className="mt-10 rounded-lg border border-dashed p-8 text-center">
        <p className="font-medium">This area has not moved yet.</p>
        <p className="mt-2 text-sm text-muted-foreground">
          {area} is still served by the Next.js app while Phase 7 ports the
          dashboard one area at a time. Run <code>pnpm dev</code> for it; the
          Worker serves everything else.
        </p>
      </div>
    </div>
  );
}
