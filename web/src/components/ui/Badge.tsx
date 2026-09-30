import React from 'react';
import { StatusDot, StatusType } from './StatusDot';

export type BadgeVariant =
  | 'default'
  | 'neutral'
  | 'lime'
  | 'running'
  | 'verified'
  | 'awaiting'
  | 'accepted'
  | 'integrating'
  | 'integrated'
  | 'failed'
  | 'rejected'
  | 'needshuman'
  | 'outline';

export interface BadgeProps {
  children: React.ReactNode;
  variant?: BadgeVariant;
  size?: 'xs' | 'sm' | 'md';
  statusDot?: StatusType | boolean;
  pulse?: boolean;
  className?: string;
  mono?: boolean;
}

export const Badge: React.FC<BadgeProps> = ({
  children,
  variant = 'default',
  size = 'sm',
  statusDot,
  pulse = false,
  className = '',
  mono = true,
}) => {
  const sizeStyles = {
    xs: 'text-[10px] px-1.5 py-0.2 gap-1 rounded-xs',
    sm: 'text-[11px] px-2 py-0.5 gap-1.5 rounded-sm',
    md: 'text-xs px-2.5 py-1 gap-1.5 rounded',
  };

  const variantStyles: Record<BadgeVariant, string> = {
    default:
      'bg-surface-card text-gray-300 border border-surface-border',
    neutral:
      'bg-surface-base text-gray-400 border border-surface-border',
    lime:
      'bg-sentinel-lime-muted text-sentinel-lime border border-sentinel-lime-border font-semibold',
    running:
      'bg-sky-950/40 text-status-running border border-sky-800/50',
    verified:
      'bg-emerald-950/40 text-status-verified border border-emerald-800/50',
    awaiting:
      'bg-amber-950/40 text-status-awaiting border border-amber-800/50',
    accepted:
      'bg-blue-950/40 text-status-accepted border border-blue-800/50',
    integrating:
      'bg-indigo-950/40 text-status-integrating border border-indigo-800/50',
    integrated:
      'bg-emerald-950/40 text-status-integrated border border-emerald-800/50',
    failed:
      'bg-red-950/40 text-status-failed border border-red-800/50',
    rejected:
      'bg-rose-950/40 text-status-rejected border border-rose-800/50',
    needshuman:
      'bg-amber-950/50 text-status-needshuman border border-amber-600/60 font-semibold',
    outline:
      'bg-transparent text-gray-400 border border-surface-border',
  };

  const dotStatus = typeof statusDot === 'string' ? statusDot : (variant as StatusType);

  return (
    <span
      className={`inline-flex items-center tracking-tight font-medium uppercase select-none ${
        mono ? 'font-mono' : ''
      } ${sizeStyles[size]} ${variantStyles[variant]} ${className}`}
    >
      {statusDot && (
        <StatusDot
          status={dotStatus}
          pulse={pulse}
          size={size === 'xs' ? 'xs' : 'sm'}
        />
      )}
      <span>{children}</span>
    </span>
  );
};
