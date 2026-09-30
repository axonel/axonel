import React from 'react';

export interface PanelProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  headerActions?: React.ReactNode;
  footer?: React.ReactNode;
  dense?: boolean;
  variant?: 'default' | 'subtle' | 'ghost' | 'lime';
  noPadding?: boolean;
}

export const Panel: React.FC<PanelProps> = ({
  children,
  title,
  subtitle,
  headerActions,
  footer,
  dense = false,
  variant = 'default',
  noPadding = false,
  className = '',
  ...props
}) => {
  const variantStyles = {
    default: 'bg-surface-card border border-surface-border',
    subtle: 'bg-surface-base border border-surface-border',
    ghost: 'bg-transparent border border-surface-border',
    lime: 'bg-surface-card border border-surface-border border-t-2 border-t-sentinel-lime',
  };

  const paddingClass = noPadding
    ? ''
    : dense
    ? 'p-3'
    : 'p-4 sm:p-5';

  return (
    <div
      className={`rounded overflow-hidden flex flex-col ${variantStyles[variant]} ${className}`}
      {...props}
    >
      {(title || subtitle || headerActions) && (
        <div
          className={`flex items-center justify-between border-b border-surface-border ${
            dense ? 'px-3 py-2' : 'px-4 py-3 sm:px-5'
          } bg-surface-header/50`}
        >
          <div className="min-w-0 pr-2">
            {title && (
              <div className="text-xs sm:text-sm font-semibold text-gray-200 tracking-tight flex items-center gap-2">
                {title}
              </div>
            )}
            {subtitle && (
              <div className="text-[11px] text-gray-400 mt-0.5 font-normal truncate">
                {subtitle}
              </div>
            )}
          </div>
          {headerActions && (
            <div className="flex items-center gap-2 shrink-0">{headerActions}</div>
          )}
        </div>
      )}

      <div className={`flex-1 ${paddingClass}`}>{children}</div>

      {footer && (
        <div
          className={`border-t border-surface-border bg-surface-header/30 ${
            dense ? 'px-3 py-2' : 'px-4 py-3 sm:px-5'
          }`}
        >
          {footer}
        </div>
      )}
    </div>
  );
};
