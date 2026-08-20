import { useCallback } from 'react'
import { useAddBookmarkToList, useCreateBookmark, useUploadAsset } from './queries'
import { assetKindFor, type Bookmark } from '../../../shared/types'
import { errMessage } from './errors'

export interface FileBookmarkFailure {
  fileName: string
  message: string
}

export interface FileBookmarkResult {
  created: Bookmark[]
  failed: FileBookmarkFailure[]
}

/**
 * Content types the server will accept as an asset *and* hang a bookmark
 * off. Used only as a cheap client-side pre-check so a 200MB video isn't
 * uploaded just to be rejected — the server sniffs the actual bytes and has
 * the final say, so a file whose type the browser can't guess (empty
 * `File.type`, which is what an unrecognized extension gives) is sent
 * anyway rather than refused here.
 */
function isObviouslyUnsupported(mimeType: string): boolean {
  if (!mimeType) return false
  return assetKindFor(mimeType) === null
}

/**
 * Turns local files into Karakeep bookmarks: upload the bytes, then create
 * an `asset` bookmark pointing at the stored asset.
 *
 * Files are handled one at a time rather than in parallel. A drop of twenty
 * PDFs firing twenty concurrent multipart uploads is a good way to make a
 * self-hosted instance fall over, and the sequential version reports which
 * file failed in a way a Promise.all rejection can't.
 *
 * Never throws: a batch where some files worked and others didn't is the
 * normal case, so both halves come back in the result and the caller
 * decides how loudly to say so.
 */
export function useCreateFileBookmarks(): (
  files: File[],
  options?: { listId?: string }
) => Promise<FileBookmarkResult> {
  const uploadAsset = useUploadAsset()
  const createBookmark = useCreateBookmark()
  const addToList = useAddBookmarkToList()

  return useCallback(
    async (files: File[], options?: { listId?: string }): Promise<FileBookmarkResult> => {
      const created: Bookmark[] = []
      const failed: FileBookmarkFailure[] = []

      for (const file of files) {
        if (isObviouslyUnsupported(file.type)) {
          failed.push({
            fileName: file.name,
            message: `${file.type} files can't be bookmarked — Karakeep stores PDFs and images.`
          })
          continue
        }

        try {
          const asset = await uploadAsset.mutateAsync({
            fileName: file.name,
            mimeType: file.type || 'application/octet-stream',
            data: await file.arrayBuffer()
          })

          // The kind comes from what the server says it stored, not from
          // the local extension: POST /bookmarks rejects anything outside
          // { image, pdf }, and the server's sniffed type is the only
          // reading of the file that matches what it will enforce.
          const kind = assetKindFor(asset.contentType)
          if (!kind) {
            failed.push({
              fileName: file.name,
              message: `Uploaded, but Karakeep can't make a bookmark out of a ${asset.contentType} file.`
            })
            continue
          }

          const bookmark = await createBookmark.mutateAsync({
            type: 'asset',
            assetType: kind,
            assetId: asset.assetId,
            fileName: asset.fileName || file.name
          })
          created.push(bookmark)

          if (options?.listId) {
            // A failure here is not a failed import — the bookmark exists,
            // it just isn't filed. Say so rather than reporting the whole
            // file as lost.
            try {
              await addToList.mutateAsync({ listId: options.listId, bookmarkId: bookmark.id })
            } catch (err) {
              failed.push({
                fileName: file.name,
                message: `Added to your library, but couldn't be filed into the list. ${errMessage(err)}`
              })
            }
          }
        } catch (err) {
          failed.push({ fileName: file.name, message: errMessage(err) })
        }
      }

      return { created, failed }
    },
    [uploadAsset, createBookmark, addToList]
  )
}

