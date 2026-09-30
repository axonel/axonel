import React from 'react';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  helperText?: string;
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
  mono?: boolean;
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  (
    {
      label,
      error,
      helperText,
      leftIcon,
      rightIcon,
      mono = false,
      className = '',
      id,
      ...props
    },
    ref
  ) => {
    const inputId = id || (label ? label.toLowerCase().replace(/\s+/g, '-') : undefined);

    return (
      <div className="w-full space-y-1">
        {label && (
          <label
            htmlFor={inputId}
            className="block text-xs font-medium text-gray-300 select-none tracking-tight"
          >
            {label}
          </label>
        )}
        <div className="relative flex items-center">
          {leftIcon && (
            <div className="absolute left-2.5 text-gray-500 pointer-events-none flex items-center justify-center">
              {leftIcon}
            </div>
          )}
          <input
            id={inputId}
            ref={ref}
            className={`w-full bg-surface-base border ${
              error ? 'border-red-500/80 focus:border-red-500' : 'border-surface-border focus:border-sentinel-lime'
            } rounded px-3 py-1.5 text-xs sm:text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-1 ${
              error ? 'focus:ring-red-500' : 'focus:ring-sentinel-lime'
            } transition-colors ${mono ? 'font-mono' : ''} ${leftIcon ? 'pl-8' : ''} ${
              rightIcon ? 'pr-8' : ''
            } disabled:opacity-50 disabled:cursor-not-allowed ${className}`}
            {...props}
          />
          {rightIcon && (
            <div className="absolute right-2.5 text-gray-500 pointer-events-none flex items-center justify-center">
              {rightIcon}
            </div>
          )}
        </div>
        {error ? (
          <p className="text-[11px] text-red-400 font-mono">{error}</p>
        ) : helperText ? (
          <p className="text-[11px] text-gray-500">{helperText}</p>
        ) : null}
      </div>
    );
  }
);
Input.displayName = 'Input';

export interface TextareaProps
  extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  error?: string;
  helperText?: string;
  mono?: boolean;
}

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ label, error, helperText, mono = false, className = '', id, ...props }, ref) => {
    const inputId = id || (label ? label.toLowerCase().replace(/\s+/g, '-') : undefined);

    return (
      <div className="w-full space-y-1">
        {label && (
          <label
            htmlFor={inputId}
            className="block text-xs font-medium text-gray-300 select-none tracking-tight"
          >
            {label}
          </label>
        )}
        <textarea
          id={inputId}
          ref={ref}
          className={`w-full bg-surface-base border ${
            error ? 'border-red-500/80 focus:border-red-500' : 'border-surface-border focus:border-sentinel-lime'
          } rounded px-3 py-2 text-xs sm:text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-1 ${
            error ? 'focus:ring-red-500' : 'focus:ring-sentinel-lime'
          } transition-colors ${mono ? 'font-mono' : ''} disabled:opacity-50 disabled:cursor-not-allowed ${className}`}
          {...props}
        />
        {error ? (
          <p className="text-[11px] text-red-400 font-mono">{error}</p>
        ) : helperText ? (
          <p className="text-[11px] text-gray-500">{helperText}</p>
        ) : null}
      </div>
    );
  }
);
Textarea.displayName = 'Textarea';

export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  error?: string;
  helperText?: string;
  mono?: boolean;
}

export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({ label, error, helperText, mono = false, className = '', id, children, ...props }, ref) => {
    const inputId = id || (label ? label.toLowerCase().replace(/\s+/g, '-') : undefined);

    return (
      <div className="w-full space-y-1">
        {label && (
          <label
            htmlFor={inputId}
            className="block text-xs font-medium text-gray-300 select-none tracking-tight"
          >
            {label}
          </label>
        )}
        <select
          id={inputId}
          ref={ref}
          className={`w-full bg-surface-base border ${
            error ? 'border-red-500/80 focus:border-red-500' : 'border-surface-border focus:border-sentinel-lime'
          } rounded px-3 py-1.5 text-xs sm:text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-1 ${
            error ? 'focus:ring-red-500' : 'focus:ring-sentinel-lime'
          } transition-colors ${mono ? 'font-mono' : ''} disabled:opacity-50 disabled:cursor-not-allowed ${className}`}
          {...props}
        >
          {children}
        </select>
        {error ? (
          <p className="text-[11px] text-red-400 font-mono">{error}</p>
        ) : helperText ? (
          <p className="text-[11px] text-gray-500">{helperText}</p>
        ) : null}
      </div>
    );
  }
);
Select.displayName = 'Select';
