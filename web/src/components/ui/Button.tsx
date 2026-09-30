import React from 'react';

export type ButtonVariant =
  | 'primary'
  | 'secondary'
  | 'outline'
  | 'ghost'
  | 'danger'
  | 'danger-ghost'
  | 'lime-outline';

export type ButtonSize = 'xs' | 'sm' | 'md';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: React.ReactNode;
  loading?: boolean;
}

export const Button: React.FC<ButtonProps> = ({
  children,
  variant = 'secondary',
  size = 'sm',
  icon,
  loading = false,
  className = '',
  disabled,
  ...props
}) => {
  const baseStyles =
    'inline-flex items-center justify-center font-medium transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-sentinel-lime disabled:opacity-40 disabled:pointer-events-none select-none';

  const sizeStyles: Record<ButtonSize, string> = {
    xs: 'text-[11px] px-2 py-0.5 gap-1 rounded-sm font-mono',
    sm: 'text-xs px-2.5 py-1.5 gap-1.5 rounded',
    md: 'text-sm px-3.5 py-2 gap-2 rounded',
  };

  const variantStyles: Record<ButtonVariant, string> = {
    primary:
      'bg-sentinel-lime hover:bg-sentinel-lime-hover text-black font-semibold border border-sentinel-lime shadow-none',
    secondary:
      'bg-surface-card hover:bg-surface-hover text-gray-200 border border-surface-border hover:border-surface-border-bold',
    outline:
      'bg-transparent hover:bg-surface-card text-gray-300 border border-surface-border hover:border-surface-border-bold hover:text-white',
    ghost:
      'bg-transparent hover:bg-surface-hover text-gray-400 hover:text-gray-200 border border-transparent',
    danger:
      'bg-red-950/50 hover:bg-red-900/70 text-red-300 border border-red-800/60 hover:border-red-700',
    'danger-ghost':
      'bg-transparent hover:bg-red-950/40 text-red-400 hover:text-red-300 border border-transparent',
    'lime-outline':
      'bg-sentinel-lime-muted hover:bg-sentinel-lime/20 text-sentinel-lime border border-sentinel-lime-border',
  };

  return (
    <button
      className={`${baseStyles} ${sizeStyles[size]} ${variantStyles[variant]} ${className}`}
      disabled={disabled || loading}
      {...props}
    >
      {loading ? (
        <span className="w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" />
      ) : (
        icon && <span className="shrink-0">{icon}</span>
      )}
      {children}
    </button>
  );
};
