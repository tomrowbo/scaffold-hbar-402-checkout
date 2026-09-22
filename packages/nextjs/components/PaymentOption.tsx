import React from "react";

export type PaymentOptionProps = {
  /** Rail label — "Card", "Hedera" or "x402". */
  label: string;
  description: string;
  /** Environment variables that switch this rail on. */
  envVars: string[];
  /** Result of the rail's predicate in `~~/lib/demo`. */
  enabled: boolean;
  icon?: React.ReactNode;
};

export const PaymentOption = ({ label, description, envVars, enabled, icon }: PaymentOptionProps) => {
  return (
    <div className={`card border bg-base-100 ${enabled ? "border-primary/40 shadow-sm" : "border-base-300"}`}>
      <div className="card-body gap-3 py-5">
        <div className="flex items-center justify-between gap-3">
          <h3 className="card-title text-base m-0 flex items-center gap-2">
            {icon}
            {label}
          </h3>
          {enabled ? (
            <span className="badge badge-success badge-sm">live</span>
          ) : (
            <span className="badge badge-ghost badge-sm">demo mode</span>
          )}
        </div>

        <p className="text-sm text-base-content/70 m-0">{description}</p>

        <button type="button" className="btn btn-primary btn-sm w-full" disabled={!enabled}>
          Pay with {label}
        </button>

        {!enabled && (
          <p className="text-xs text-base-content/60 m-0">
            Running in <span className="font-semibold">demo mode</span> — set{" "}
            {envVars.map((name, index) => (
              <React.Fragment key={name}>
                {index > 0 && " "}
                <code className="bg-base-300 px-1 py-0.5 rounded text-[11px]">{name}</code>
              </React.Fragment>
            ))}{" "}
            in <code className="bg-base-300 px-1 py-0.5 rounded text-[11px]">packages/nextjs/.env</code> to enable this
            rail.
          </p>
        )}
      </div>
    </div>
  );
};
