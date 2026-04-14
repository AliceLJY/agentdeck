'use client';

import { useState, useCallback, useRef } from 'react';

interface DropZoneProps {
  token: string;
  onFileUploaded: (filePath: string) => void;
  children: React.ReactNode;
}

export default function DropZone({ token, onFileUploaded, children }: DropZoneProps) {
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const dragCountRef = useRef(0);

  const uploadFile = useCallback(async (file: File) => {
    if (!token) return;

    setUploading(true);
    try {
      const formData = new FormData();
      formData.append('file', file);

      const res = await fetch('/api/upload', {
        method: 'POST',
        headers: { 'x-token': token },
        body: formData,
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Upload failed');
      }

      const data = await res.json();
      onFileUploaded(data.path);
    } catch (err) {
      console.error('[cc-terminal] Drop upload error:', err);
    } finally {
      setUploading(false);
    }
  }, [token, onFileUploaded]);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCountRef.current++;
    if (dragCountRef.current === 1) {
      setDragging(true);
    }
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCountRef.current--;
    if (dragCountRef.current === 0) {
      setDragging(false);
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCountRef.current = 0;
    setDragging(false);

    const files = e.dataTransfer.files;
    if (files.length > 0) {
      // Upload first file (can extend to multi later)
      uploadFile(files[0]);
    }
  }, [uploadFile]);

  return (
    <div
      className="relative w-full h-full"
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {children}

      {/* Drag overlay */}
      {(dragging || uploading) && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-blue-500/20 backdrop-blur-sm border-2 border-dashed border-blue-400 rounded-lg pointer-events-none">
          <div className="bg-gray-900/90 text-white px-6 py-4 rounded-xl text-center">
            {uploading ? (
              <>
                <svg className="w-8 h-8 mx-auto mb-2 animate-spin text-blue-400" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                <p className="text-sm">Uploading...</p>
              </>
            ) : (
              <>
                <svg className="w-8 h-8 mx-auto mb-2 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                </svg>
                <p className="text-sm font-medium">Drop file here</p>
                <p className="text-xs text-gray-400 mt-1">Path will be typed into terminal</p>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
