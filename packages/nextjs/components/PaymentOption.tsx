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
  /** Replaces the inert placeholder button for rails that can actually take a payment. */
  action?: React.ReactNode;
};

export const PaymentOption = ({ label, description, envVars, enabled, icon, action }: PaymentOptionProps) => {
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

        {action ?? (
          <button type="button" className="btn btn-primary btn-sm w-full" disabled={!enabled}>
            Pay with {label}
          </button>
        )}

        {!enabled && (
          // The variable names are the one thing a first run actually needs; everything
          // else about this rail is in the README.
          <p className="text-xs text-base-content/60 m-0 flex flex-wrap gap-1 items-center">
            <span>Set in</span>
            <code className="bg-base-300 px-1 py-0.5 rounded text-[11px]">packages/nextjs/.env</code>
            {envVars.map(name => (
              <code key={name} className="bg-base-300 px-1 py-0.5 rounded text-[11px]">
                {name}
              </code>
            ))}
          </p>
        )}
      </div>
    </div>
  );
};
