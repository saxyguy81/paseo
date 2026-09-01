import { useEffect, useState } from "react";
import { subscribeToRelativeTimeTick, type TickResolution } from "@/utils/relative-time-ticker";
import { describeTurnCompletionTime } from "@/utils/time";

/** Keeps one completed-turn label current using the shared relative-time clock. */
export function useTurnCompletionTime(date: Date | null): string {
  const [label, setLabel] = useState(() => (date ? describeTurnCompletionTime(date).label : ""));
  const time = date?.getTime() ?? null;

  useEffect(() => {
    if (time === null) {
      setLabel("");
      return undefined;
    }

    const source = new Date(time);
    let current = describeTurnCompletionTime(source);
    setLabel(current.label);
    let unsubscribe: (() => void) | null = null;

    const attach = () => {
      if (current.resolution === "static") return;
      unsubscribe = subscribeToRelativeTimeTick(current.resolution as TickResolution, handleTick);
    };
    const handleTick = () => {
      const next = describeTurnCompletionTime(source);
      if (next.label !== current.label) setLabel(next.label);
      if (next.resolution !== current.resolution) {
        current = next;
        unsubscribe?.();
        unsubscribe = null;
        attach();
        return;
      }
      current = next;
    };

    attach();
    return () => unsubscribe?.();
  }, [time]);

  return label;
}
