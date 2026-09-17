/**
 * The splash shown while the session and the team are still resolving.
 *
 * A plain `<img>` rather than `next/image`: it is one 45px logo from `public/`,
 * so the srcset and lazy-loading machinery bought nothing, and the component
 * is now loadable from either framework (#9).
 */
export const FullScreenLoading = () => {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <img
        src="/logo-squircle.png"
        alt="useSend"
        width={45}
        height={45}
        className="mx-auto"
      />
    </div>
  );
};
