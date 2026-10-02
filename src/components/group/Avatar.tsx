import type { GroupMember } from "@/core/group";
import { cx } from "../ui";

const COLORS = ["bg-rose-500", "bg-sky-500", "bg-emerald-500", "bg-amber-500", "bg-violet-500", "bg-teal-500"];

/** メンバーのアイコン（名前の頭文字）。「誰の希望か」の表示などに使う */
export function Avatar({ member, index, size = "md", testId }: { member: GroupMember; index: number; size?: "sm" | "md"; testId?: string }) {
  return (
    <span
      title={member.name}
      aria-label={member.name}
      data-testid={testId}
      className={cx(
        "inline-flex shrink-0 items-center justify-center rounded-full font-bold text-white",
        COLORS[index % COLORS.length],
        size === "sm" ? "size-5 text-[10px]" : "size-7 text-xs",
      )}
    >
      {Array.from(member.name)[0] ?? "?"}
    </span>
  );
}

export function memberIndex(members: GroupMember[], id: string): number {
  return Math.max(0, members.findIndex((m) => m.id === id));
}
