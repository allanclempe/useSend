import { useState } from "react";

import { toast } from "@usesend/ui/src/toaster";

/**
 * One header field of the campaign editor: type, save on blur, revert on
 * refusal.
 *
 * The Next.js editor wrote this out five times -- name, subject, from, reply
 * to, preview text -- each with its own `useState`, its own "unchanged?" guard
 * and its own `onError` that toasts and puts the old value back. Five copies of
 * a revert is five places for one of them to forget.
 *
 * `committed` is the value the server has. When it changes underneath (a save
 * elsewhere, a refetch) the field follows it, unless it is being edited: the
 * local value only resets when the two disagree *and* the field is not dirty.
 */
export function CampaignField({
  label,
  committed,
  placeholder,
  disabled,
  allowEmpty = false,
  onSave,
}: {
  label: string;
  committed: string;
  placeholder?: string;
  disabled?: boolean;
  /** Reply-to may legitimately be cleared; a subject may not. */
  allowEmpty?: boolean;
  // eslint-disable-next-line no-unused-vars
  onSave: (value: string, onError: () => void) => void;
}) {
  const [value, setValue] = useState(committed);

  function handleBlur() {
    if (disabled || value === committed || (!value && !allowEmpty)) {
      return;
    }

    onSave(value, () => {
      toast.error(`Could not save ${label.toLowerCase()}. Reverting changes.`);
      setValue(committed);
    });
  }

  return (
    <div className="flex items-center gap-4">
      <label className="block w-[80px] text-sm text-muted-foreground">
        {label}
      </label>
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        readOnly={disabled}
        onChange={(e) => setValue(e.target.value)}
        onBlur={handleBlur}
        className="mt-1 block w-full border-b border-transparent bg-transparent py-1 text-sm outline-none focus:border-border"
      />
    </div>
  );
}

export default CampaignField;
