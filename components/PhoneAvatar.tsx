import { initials, avatarColor, cn } from '@/lib/utils';

export function PhoneAvatar({ firstName, lastName, phone, size = 'md' }: {
  firstName?: string | null; lastName?: string | null; phone: string;
  size?: 'sm' | 'md';
}) {
  const seed = (firstName ?? '') + (lastName ?? '') + phone;
  return (
    <div className={cn(
      'flex items-center justify-center rounded-full text-white font-medium shrink-0',
      avatarColor(seed),
      size === 'md' ? 'size-10 text-sm' : 'size-8 text-xs',
    )}>
      {initials(firstName, lastName, phone.slice(-2))}
    </div>
  );
}
