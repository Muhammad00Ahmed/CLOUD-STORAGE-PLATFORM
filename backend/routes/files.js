const express = require('express');
const multer = require('multer');
const AWS = require('aws-sdk');
const crypto = require('crypto');
const path = require('path');
const File = require('../models/File');
const Folder = require('../models/Folder');
const { authenticate } = require('../middleware/auth');
const { io } = require('../server');

const router = express.Router();

// Configure AWS S3
const s3 = new AWS.S3({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION
});

// Configure multer for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024 * 1024 // 5GB limit
  }
});

// Encryption helper
const encryptFile = (buffer) => {
  const algorithm = 'aes-256-cbc';
  const key = Buffer.from(process.env.ENCRYPTION_KEY, 'hex');
  const iv = crypto.randomBytes(16);
  
  const cipher = crypto.createCipheriv(algorithm, key, iv);
  const encrypted = Buffer.concat([cipher.update(buffer), cipher.final()]);
  
  return {
    iv: iv.toString('hex'),
    data: encrypted
  };
};

const decryptFile = (encryptedData, iv) => {
  const algorithm = 'aes-256-cbc';
  const key = Buffer.from(process.env.ENCRYPTION_KEY, 'hex');
  const ivBuffer = Buffer.from(iv, 'hex');
  
  const decipher = crypto.createDecipheriv(algorithm, key, ivBuffer);
  const decrypted = Buffer.concat([
    decipher.update(encryptedData),
    decipher.final()
  ]);
  
  return decrypted;
};

// Upload file
router.post('/upload', authenticate, upload.single('file'), async (req, res) => {
  try {
    const { folderId, tags } = req.body;
    const file = req.file;
    
    if (!file) {
      return res.status(400).json({
        success: false,
        message: 'No file provided'
      });
    }
    
    // Check storage quota
    const userStorage = await File.aggregate([
      { $match: { userId: req.user.id, deletedAt: null } },
      { $group: { _id: null, total: { $sum: '$size' } } }
    ]);
    
    const currentUsage = userStorage[0]?.total || 0;
    const quota = req.user.storageQuota || 10 * 1024 * 1024 * 1024; // 10GB default
    
    if (currentUsage + file.size > quota) {
      return res.status(400).json({
        success: false,
        message: 'Storage quota exceeded'
      });
    }
    
    // Encrypt file
    const encrypted = encryptFile(file.buffer);
    
    // Generate unique file key
    const fileKey = `${req.user.id}/${Date.now()}_${crypto.randomBytes(8).toString('hex')}${path.extname(file.originalname)}`;
    
    // Upload to S3
    const s3Params = {
      Bucket: process.env.AWS_BUCKET_NAME,
      Key: fileKey,
      Body: encrypted.data,
      ContentType: file.mimetype,
      ServerSideEncryption: 'AES256',
      Metadata: {
        userId: req.user.id.toString(),
        originalName: file.originalname,
        iv: encrypted.iv
      }
    };
    
    await s3.upload(s3Params).promise();
    
    // Create file record
    const fileRecord = await File.create({
      name: file.originalname,
      originalName: file.originalname,
      mimeType: file.mimetype,
      size: file.size,
      s3Key: fileKey,
      encryptionIv: encrypted.iv,
      userId: req.user.id,
      folderId: folderId || null,
      tags: tags ? tags.split(',') : [],
      checksum: crypto.createHash('md5').update(file.buffer).digest('hex'),
      versions: [{
        version: 1,
        s3Key: fileKey,
        size: file.size,
        createdAt: new Date(),
        createdBy: req.user.id
      }]
    });
    
    await fileRecord.populate('userId', 'firstName lastName email');
    
    // Emit real-time update
    io.to(`user:${req.user.id}`).emit('file:uploaded', fileRecord);
    
    res.status(201).json({
      success: true,
      data: fileRecord,
      message: 'File uploaded successfully'
    });
  } catch (error) {
    console.error('Error uploading file:', error);
    res.status(500).json({
      success: false,
      message: 'Error uploading file'
    });
  }
});

// Download file
router.get('/:id/download', authenticate, async (req, res) => {
  try {
    const file = await File.findById(req.params.id);
    
    if (!file) {
      return res.status(404).json({
        success: false,
        message: 'File not found'
      });
    }
    
    // Check access permission
    if (file.userId.toString() !== req.user.id && !file.sharedWith.includes(req.user.id)) {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }
    
    // Get file from S3
    const s3Params = {
      Bucket: process.env.AWS_BUCKET_NAME,
      Key: file.s3Key
    };
    
    const s3Object = await s3.getObject(s3Params).promise();
    
    // Decrypt file
    const decrypted = decryptFile(s3Object.Body, file.encryptionIv);
    
    // Update download count
    file.downloads += 1;
    file.lastAccessedAt = new Date();
    await file.save();
    
    // Set response headers
    res.setHeader('Content-Type', file.mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${file.originalName}"`);
    res.setHeader('Content-Length', decrypted.length);
    
    res.send(decrypted);
  } catch (error) {
    console.error('Error downloading file:', error);
    res.status(500).json({
      success: false,
      message: 'Error downloading file'
    });
  }
});

// Get file info
router.get('/:id', authenticate, async (req, res) => {
  try {
    const file = await File.findById(req.params.id)
      .populate('userId', 'firstName lastName email')
      .populate('folderId', 'name path');
    
    if (!file) {
      return res.status(404).json({
        success: false,
        message: 'File not found'
      });
    }
    
    // Check access permission
    if (file.userId._id.toString() !== req.user.id && !file.sharedWith.includes(req.user.id)) {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }
    
    res.json({
      success: true,
      data: file
    });
  } catch (error) {
    console.error('Error fetching file:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching file'
    });
  }
});

// List files
router.get('/', authenticate, async (req, res) => {
  try {
    const {
      page = 1,
      limit = 50,
      folderId,
      search,
      mimeType,
      sortBy = 'createdAt',
      order = 'desc'
    } = req.query;
    
    const query = {
      userId: req.user.id,
      deletedAt: null
    };
    
    // Filter by folder
    if (folderId) {
      query.folderId = folderId;
    } else if (folderId === 'root') {
      query.folderId = null;
    }
    
    // Search
    if (search) {
      query.name = { $regex: search, $options: 'i' };
    }
    
    // Filter by mime type
    if (mimeType) {
      query.mimeType = { $regex: mimeType, $options: 'i' };
    }
    
    const files = await File.find(query)
      .populate('userId', 'firstName lastName')
      .populate('folderId', 'name')
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .sort({ [sortBy]: order === 'desc' ? -1 : 1 })
      .exec();
    
    const count = await File.countDocuments(query);
    
    res.json({
      success: true,
      data: files,
      totalPages: Math.ceil(count / limit),
      currentPage: page,
      total: count
    });
  } catch (error) {
    console.error('Error fetching files:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching files'
    });
  }
});

// Share file
router.post('/:id/share', authenticate, async (req, res) => {
  try {
    const { emails, permissions, expiresAt, password } = req.body;
    
    const file = await File.findById(req.params.id);
    
    if (!file) {
      return res.status(404).json({
        success: false,
        message: 'File not found'
      });
    }
    
    if (file.userId.toString() !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }
    
    // Generate share link
    const shareToken = crypto.randomBytes(32).toString('hex');
    
    file.shareLinks.push({
      token: shareToken,
      createdBy: req.user.id,
      permissions: permissions || 'view',
      expiresAt: expiresAt ? new Date(expiresAt) : null,
      password: password ? crypto.createHash('sha256').update(password).digest('hex') : null,
      emails: emails || []
    });
    
    await file.save();
    
    const shareUrl = `${process.env.APP_URL}/share/${shareToken}`;
    
    // Send email notifications
    if (emails && emails.length > 0) {
      const { sendEmail } = require('../utils/email');
      
      for (const email of emails) {
        await sendEmail({
          to: email,
          subject: `${req.user.firstName} shared a file with you`,
          template: 'file-share',
          data: {
            fileName: file.name,
            shareUrl,
            sender: req.user.firstName
          }
        });
      }
    }
    
    res.json({
      success: true,
      data: {
        shareUrl,
        token: shareToken
      },
      message: 'File shared successfully'
    });
  } catch (error) {
    console.error('Error sharing file:', error);
    res.status(500).json({
      success: false,
      message: 'Error sharing file'
    });
  }
});

// Delete file (move to trash)
router.delete('/:id', authenticate, async (req, res) => {
  try {
    const file = await File.findById(req.params.id);
    
    if (!file) {
      return res.status(404).json({
        success: false,
        message: 'File not found'
      });
    }
    
    if (file.userId.toString() !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }
    
    // Move to trash
    file.deletedAt = new Date();
    file.deletedBy = req.user.id;
    await file.save();
    
    // Emit real-time update
    io.to(`user:${req.user.id}`).emit('file:deleted', { fileId: file._id });
    
    res.json({
      success: true,
      message: 'File moved to trash'
    });
  } catch (error) {
    console.error('Error deleting file:', error);
    res.status(500).json({
      success: false,
      message: 'Error deleting file'
    });
  }
});

// Restore file from trash
router.post('/:id/restore', authenticate, async (req, res) => {
  try {
    const file = await File.findById(req.params.id);
    
    if (!file) {
      return res.status(404).json({
        success: false,
        message: 'File not found'
      });
    }
    
    if (file.userId.toString() !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }
    
    file.deletedAt = null;
    file.deletedBy = null;
    await file.save();
    
    res.json({
      success: true,
      data: file,
      message: 'File restored successfully'
    });
  } catch (error) {
    console.error('Error restoring file:', error);
    res.status(500).json({
      success: false,
      message: 'Error restoring file'
    });
  }
});

// Get storage usage
router.get('/storage/usage', authenticate, async (req, res) => {
  try {
    const usage = await File.aggregate([
      { $match: { userId: req.user.id, deletedAt: null } },
      {
        $group: {
          _id: null,
          totalSize: { $sum: '$size' },
          totalFiles: { $sum: 1 }
        }
      }
    ]);
    
    const byType = await File.aggregate([
      { $match: { userId: req.user.id, deletedAt: null } },
      {
        $group: {
          _id: '$mimeType',
          size: { $sum: '$size' },
          count: { $sum: 1 }
        }
      }
    ]);
    
    res.json({
      success: true,
      data: {
        totalSize: usage[0]?.totalSize || 0,
        totalFiles: usage[0]?.totalFiles || 0,
        quota: req.user.storageQuota || 10 * 1024 * 1024 * 1024,
        byType
      }
    });
  } catch (error) {
    console.error('Error fetching storage usage:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching storage usage'
    });
  }
});

module.exports = router;