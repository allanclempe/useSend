import { useMutation } from "@tanstack/react-query";
import { Copy, RotateCw } from "lucide-react";

import { Button } from "@usesend/ui/src/button";
import { toast } from "@usesend/ui/src/toaster";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@usesend/ui/src/tooltip";

import { resendTeamInvite } from "~/server/functions/team";
import { isSelfHosted } from "~/utils/common";

/**
 * Send a pending invite again, and — self-hosted only — copy its link.
 *
 * The copy button exists because a self-hosted installation may have no
 * verified sending domain, in which case the invite email cannot go out and
 * the link is the only way to hand the invite over.
 *
 * Nothing here invalidates: resending does not change the invite row, and the
 * list already shows it.
 */
export const ResendTeamInvite: React.FC<{
  invite: { id: string; email: string };
}> = ({ invite }) => {
  const resend = useMutation({
    mutationFn: resendTeamInvite,
    onSuccess: () => toast.success(`Invite resent to ${invite.email}`),
    onError: (error) => toast.error(error.message),
  });

  function copyLink() {
    void navigator.clipboard.writeText(
      `${location.origin}/join-team?inviteId=${invite.id}`,
    );
    toast.success("Invite link copied to clipboard");
  }

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            disabled={resend.isPending}
            onClick={() => resend.mutate({ data: { inviteId: invite.id } })}
          >
            <RotateCw className="h-4 w-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          <p>Resend invite</p>
        </TooltipContent>
      </Tooltip>

      {isSelfHosted() ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="sm" onClick={copyLink}>
              <Copy className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            <p>Copy invite link</p>
          </TooltipContent>
        </Tooltip>
      ) : null}
    </TooltipProvider>
  );
};

export default ResendTeamInvite;
