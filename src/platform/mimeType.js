const path = require('path');

const MIME_BY_EXTENSION = {
	'.aac': 'audio/aac',
	'.avi': 'video/x-msvideo',
	'.bin': 'application/octet-stream',
	'.bmp': 'image/bmp',
	'.csv': 'text/csv',
	'.gif': 'image/gif',
	'.gz': 'application/gzip',
	'.htm': 'text/html',
	'.html': 'text/html',
	'.ico': 'image/x-icon',
	'.jpeg': 'image/jpeg',
	'.jpg': 'image/jpeg',
	'.js': 'text/javascript',
	'.json': 'application/json',
	'.md': 'text/markdown',
	'.mjs': 'text/javascript',
	'.mp3': 'audio/mpeg',
	'.mp4': 'video/mp4',
	'.ogg': 'audio/ogg',
	'.pdf': 'application/pdf',
	'.png': 'image/png',
	'.svg': 'image/svg+xml',
	'.tar': 'application/x-tar',
	'.ts': 'video/mp2t',
	'.txt': 'text/plain',
	'.wav': 'audio/wav',
	'.webm': 'video/webm',
	'.webp': 'image/webp',
	'.xml': 'application/xml',
	'.yaml': 'application/yaml',
	'.yml': 'application/yaml',
	'.zip': 'application/zip',
};

function inferMimeTypeFromPath(filePath, fallback = 'application/octet-stream') {
	const ext = path.extname(String(filePath || '')).toLowerCase();
	if (!ext) {
		return fallback;
	}

	return MIME_BY_EXTENSION[ext] || fallback;
}

module.exports = {
	inferMimeTypeFromPath,
};