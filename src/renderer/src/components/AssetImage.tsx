import React from 'react'
import { useQuery } from '@tanstack/react-query'

export default function AssetImage({
  assetId,
  className,
  alt
}: {
  assetId: string | null | undefined
  className?: string
  alt?: string
}): React.JSX.Element | null {
  const { data } = useQuery({
    queryKey: ['asset', assetId],
    queryFn: () => window.kk.assets.get(assetId as string),
    enabled: !!assetId,
    staleTime: 5 * 60_000
  })

  if (!assetId || !data) return null
  return <img src={data as string} className={className} alt={alt || ''} loading="lazy" />
}
