import { cn } from "@/lib/utils";

const strengthLevels = [
  { label: "Too weak", color: "bg-rose-500", textColor: "text-rose-600" },
  { label: "Weak", color: "bg-orange-500", textColor: "text-orange-600" },
  { label: "Good", color: "bg-amber-500", textColor: "text-amber-600" },
  { label: "Strong", color: "bg-emerald-500", textColor: "text-emerald-600" },
];

function getPasswordStrength(password: string) {
  let score = 0;

  if (password.length >= 8) score += 1;
  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score += 1;
  if (/\d/.test(password)) score += 1;
  if (/[^A-Za-z0-9]/.test(password)) score += 1;

  return Math.min(4, score);
}

type PasswordStrengthMeterProps = {
  password: string;
};

export default function PasswordStrengthMeter({ password }: PasswordStrengthMeterProps) {
  const score = getPasswordStrength(password);
  const level = strengthLevels[Math.max(0, score - 1)];

  return (
    <div className="space-y-2">
      <div className="flex gap-1.5">
        {Array.from({ length: 4 }).map((_, idx) => (
          <div
            key={idx}
            className={cn(
              "h-1.5 flex-1 rounded-full bg-slate-200 transition-colors",
              idx < score && level ? level.color : "bg-slate-200",
            )}
          />
        ))}
      </div>
      <p className={cn("text-xs", level ? level.textColor : "text-slate-500")}>
        {password ? `Strength: ${level?.label ?? "Too weak"}` : "Use 8+ chars with numbers and symbols."}
      </p>
    </div>
  );
}
