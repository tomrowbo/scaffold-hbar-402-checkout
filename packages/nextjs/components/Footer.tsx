import React from "react";
import { HederaPortalFaucet } from "@scaffold-hbar-ui/components";
import { hedera } from "viem/chains";
import { CurrencyDollarIcon } from "@heroicons/react/24/outline";
import { SwitchTheme } from "~~/components/SwitchTheme";
import { useTargetNetwork } from "~~/hooks/scaffold-hbar";

/**
 * Site footer
 */
export const Footer = () => {
  const { targetNetwork } = useTargetNetwork();
  const isTestnet = targetNetwork.id !== hedera.id;

  return (
    <div className="min-h-0 py-5 px-1 mb-11 lg:mb-0">
      <div>
        <div className="fixed flex justify-between items-center w-full z-10 p-4 bottom-0 left-0 pointer-events-none">
          <div className="flex flex-col md:flex-row gap-2 pointer-events-auto">
            {isTestnet && (
              <>
                {/* The store settles in USDC, so the USDC faucet comes first. HBAR still pays
                    the transaction fees, which is what the Portal faucet below is for. */}
                <a
                  href="https://faucet.circle.com"
                  target="_blank"
                  rel="noreferrer"
                  className="btn btn-primary btn-sm font-normal gap-1"
                  title="Circle's faucet — pick Hedera Testnet. Sends the USDC this store charges in."
                >
                  <CurrencyDollarIcon className="h-4 w-4" />
                  Get testnet USDC
                </a>
                <HederaPortalFaucet />
              </>
            )}
          </div>
          <SwitchTheme className="pointer-events-auto" />
        </div>
      </div>
      <div className="w-full">
        <ul className="menu menu-horizontal w-full">
          <div className="flex justify-center items-center gap-3 text-sm w-full text-base-content/60">
            <a
              href="https://github.com/hedera-dev/scaffold-hbar"
              target="_blank"
              rel="noreferrer"
              className="link hover:text-primary"
            >
              GitHub
            </a>
            <span className="opacity-30">|</span>
            <span>
              Built on{" "}
              <a
                href="https://hedera.com/"
                target="_blank"
                rel="noreferrer"
                className="font-semibold link hover:text-primary"
              >
                Hedera
              </a>
            </span>
            <span className="opacity-30">|</span>
            <a href="https://docs.hedera.com/" target="_blank" rel="noreferrer" className="link hover:text-primary">
              Docs
            </a>
          </div>
        </ul>
      </div>
    </div>
  );
};
