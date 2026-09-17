import { useMutation, useQueryClient } from "@tanstack/react-query";
import { SendHorizonal } from "lucide-react";
import React from "react";

import { Button } from "@usesend/ui/src/button";
import { toast } from "@usesend/ui/src/toaster";

import { domainKeys } from "~/queries/domain";
import { sendTestEmailFromDomain } from "~/server/functions/domain";
import type { DomainWithDnsRecords } from "~/types/domain";

export const SendTestMail: React.FC<{ domain: DomainWithDnsRecords }> = ({
  domain,
}) => {
  const queryClient = useQueryClient();

  const send = useMutation({
    mutationFn: sendTestEmailFromDomain,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: domainKeys.all });
      toast.success("Test email sent");
    },
    onError: (error) =>
      toast.error(error.message || "Failed to send test email"),
  });

  return (
    <Button
      onClick={() => send.mutate({ data: { id: domain.id } })}
      disabled={send.isPending}
    >
      <SendHorizonal className="mr-2 h-4 w-4" />
      {send.isPending ? "Sending email..." : "Send test email"}
    </Button>
  );
};

export default SendTestMail;
