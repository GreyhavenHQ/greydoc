package server

import (
	"bytes"
	"image"
	"image/jpeg"
	"image/png"
	"io"
	"os"
	"path/filepath"
	"strconv"

	"golang.org/x/image/draw"
)

// The preview asks for /uploads/<name>?w=1600. A screenshot from a retina display is often 2880 pixels
// wide but shows at 800 or less, so a smaller copy loads and paints faster. Copies are made once, on the
// first request, and kept next to the uploads.

const (
	resizeWidth = 1600
	// Larger images are served as they are, so a crafted file cannot use too much memory.
	resizeMaxPixels = 50_000_000
)

func resizeDir(uploads string) string { return filepath.Join(uploads, ".w"+strconv.Itoa(resizeWidth)) }

// resizedUpload returns the file to serve for name at resizeWidth: a smaller copy, or the original.
func (s *Server) resizedUpload(name string) (string, error) {
	original := filepath.Join(s.uploadsDir(), name)
	ext := filepath.Ext(name)
	if ext != ".png" && ext != ".jpg" {
		return original, nil
	}
	copyPath := filepath.Join(resizeDir(s.uploadsDir()), name)
	if _, err := os.Stat(copyPath); err == nil {
		return copyPath, nil
	}
	s.resizeMu.Lock()
	defer s.resizeMu.Unlock()
	if _, err := os.Stat(copyPath); err == nil {
		return copyPath, nil
	}
	data, err := os.ReadFile(original)
	if err != nil {
		return "", err
	}
	cfg, _, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || cfg.Width <= resizeWidth || cfg.Width*cfg.Height > resizeMaxPixels {
		return original, nil
	}
	src, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return original, nil
	}
	height := max(1, cfg.Height*resizeWidth/cfg.Width)
	dst := image.NewRGBA(image.Rect(0, 0, resizeWidth, height))
	draw.CatmullRom.Scale(dst, dst.Bounds(), src, src.Bounds(), draw.Src, nil)
	var out bytes.Buffer
	if ext == ".png" {
		err = png.Encode(&out, dst)
	} else {
		err = jpeg.Encode(&out, dst, &jpeg.Options{Quality: 85})
	}
	if err != nil {
		return "", err
	}
	// A copy that is not smaller is still written, so the work is not done again.
	if out.Len() >= len(data) {
		out.Reset()
		out.Write(data)
	}
	return copyPath, writeAtomic(copyPath, &out)
}

func writeAtomic(path string, r io.Reader) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".tmp-*")
	if err != nil {
		return err
	}
	if _, err := io.Copy(tmp, r); err != nil {
		tmp.Close()
		os.Remove(tmp.Name())
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmp.Name())
		return err
	}
	return os.Rename(tmp.Name(), path)
}
