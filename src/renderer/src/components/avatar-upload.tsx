import { useRef, useState } from 'react';
import { ImageOff, ImagePlus } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import type { AvatarSubject } from '@shared/api';
import { AVATAR_MAX_BYTES, AVATAR_SIZE_PX } from '@shared/constants';
import { call, errorMessage } from '@/lib/api';
import { Avatar } from './job-bits';
import { Button } from './ui/button';
import { useToast } from './ui/toast';

const ACCEPTED_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const MAX_SOURCE_BYTES = 25 * 1024 * 1024;

/**
 * Crops the middle of a picture to a small square and re-encodes it, which also drops
 * anything else the file carried, such as the location a phone recorded in a photo.
 */
export async function prepareAvatarImage(file: File): Promise<string> {
  if (!ACCEPTED_TYPES.includes(file.type)) throw new Error('Use a PNG, JPG or WebP image.');
  if (file.size > MAX_SOURCE_BYTES) throw new Error('That image is too large. Use one under 25 MB.');
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error('That file could not be read as an image.');
  }
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = AVATAR_SIZE_PX;
  canvas.height = AVATAR_SIZE_PX;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('That image could not be processed.');
  context.imageSmoothingQuality = 'high';
  context.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, AVATAR_SIZE_PX, AVATAR_SIZE_PX);
  bitmap.close();
  for (const quality of [0.9, 0.75, 0.6, 0.45]) {
    const image = canvas.toDataURL('image/webp', quality);
    if (image.length * 0.75 <= AVATAR_MAX_BYTES) return image;
  }
  throw new Error('That image is too large.');
}

/** Upload and remove buttons for one avatar: your own, or one of your profiles. */
export function AvatarEditor({ subject, label, path, size = 'md', compact = false }: { subject: AvatarSubject; label: string; path: string; size?: 'md' | 'lg'; compact?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const queryClient = useQueryClient();
  const toast = useToast();

  const run = async (action: () => Promise<unknown>, success: string) => {
    setBusy(true);
    try {
      await action();
      await queryClient.invalidateQueries();
      toast.show(success);
    } catch (error) {
      toast.show(errorMessage(error), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-3">
      <Avatar subject={subject} label={label} size={size} ring={false} />
      <div className="flex flex-wrap gap-1.5">
        <input
          ref={input}
          type="file"
          className="sr-only"
          accept={ACCEPTED_TYPES.join(',')}
          aria-label={`Upload photo for ${label}`}
          tabIndex={-1}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) void run(async () => call('POST', path, { image: await prepareAvatarImage(file) }), 'Photo updated.');
          }}
        />
        <Button size={compact ? 'icon-sm' : 'sm'} variant={compact ? 'ghost' : undefined} loading={busy} title="Upload photo" aria-label={`Choose a photo for ${label}`} onClick={() => input.current?.click()}>
          <ImagePlus />
          {compact ? null : subject.avatarVersion ? 'Change photo' : 'Upload photo'}
        </Button>
        {subject.avatarVersion ? (
          <Button size={compact ? 'icon-sm' : 'sm'} variant="danger-ghost" disabled={busy} title="Remove photo" aria-label={`Remove photo of ${label}`} onClick={() => void run(() => call('DELETE', path), 'Photo removed.')}>
            <ImageOff />
            {compact ? null : 'Remove'}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
