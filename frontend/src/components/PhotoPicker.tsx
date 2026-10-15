import { Camera, CameraResultType, CameraSource } from '@capacitor/camera'
import { useEffect, useState, type ReactNode } from 'react'
import { isNative } from '../lib/connection'

/** Take a photo or pick one from the gallery. Resolves null if the user cancels. */
async function nativePhoto(): Promise<File | null> {
  try {
    const p = await Camera.getPhoto({
      source: CameraSource.Prompt,
      resultType: CameraResultType.Uri,
      quality: 85,
      width: 1600,
      correctOrientation: true,
      promptLabelHeader: 'Garment photo',
      promptLabelPhoto: 'Choose from gallery',
      promptLabelPicture: 'Take a photo',
    })
    if (!p.webPath) return null
    const blob = await (await fetch(p.webPath)).blob()
    return new File([blob], `photo.${p.format || 'jpeg'}`, { type: blob.type || `image/${p.format || 'jpeg'}` })
  } catch {
    return null // cancelled
  }
}

/**
 * A button that opens the phone camera / gallery in the app, or a file picker in a browser.
 * `children` is the button label.
 */
export function PhotoPicker({ onPick, className = 'btn btn-secondary', disabled, children }: { onPick: (f: File) => void; className?: string; disabled?: boolean; children: ReactNode }) {
  if (isNative) {
    return (
      <button
        type="button"
        className={className}
        disabled={disabled}
        onClick={async () => {
          const f = await nativePhoto()
          if (f) onPick(f)
        }}
      >
        {children}
      </button>
    )
  }
  return (
    <label className={`${className} cursor-pointer`}>
      {children}
      <input
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="hidden"
        disabled={disabled}
        onChange={(e) => {
          const f = e.target.files?.[0]
          e.target.value = ''
          if (f) onPick(f)
        }}
      />
    </label>
  )
}

/** Small thumbnail of a picked (not yet uploaded) photo. */
export function PhotoPreview({ file }: { file: File }) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    const u = URL.createObjectURL(file)
    setUrl(u)
    return () => URL.revokeObjectURL(u)
  }, [file])
  return url ? <img src={url} alt="Selected photo" className="h-16 w-16 rounded-lg object-cover" /> : null
}
