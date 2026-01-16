//! Share-related models for permission management.

use serde::{Deserialize, Serialize};

/// Resource types that can be shared.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ResourceType {
    File,
    Folder,
}

impl std::fmt::Display for ResourceType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ResourceType::File => write!(f, "file"),
            ResourceType::Folder => write!(f, "folder"),
        }
    }
}

impl std::str::FromStr for ResourceType {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_lowercase().as_str() {
            "file" => Ok(ResourceType::File),
            "folder" => Ok(ResourceType::Folder),
            _ => Err(format!("Invalid resource type: {}", s)),
        }
    }
}

/// Permission levels for shared resources.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SharePermission {
    Owner,
    Editor,
    Commenter,
    Viewer,
}

impl SharePermission {
    /// Check if this permission allows editing.
    pub fn can_edit(&self) -> bool {
        matches!(self, SharePermission::Owner | SharePermission::Editor)
    }

    /// Check if this permission allows commenting.
    pub fn can_comment(&self) -> bool {
        matches!(
            self,
            SharePermission::Owner | SharePermission::Editor | SharePermission::Commenter
        )
    }

    /// Check if this permission allows viewing.
    pub fn can_view(&self) -> bool {
        true // All permissions can view
    }

    /// Check if this permission allows managing collaborators.
    pub fn can_manage(&self) -> bool {
        matches!(self, SharePermission::Owner)
    }
}

impl std::fmt::Display for SharePermission {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SharePermission::Owner => write!(f, "owner"),
            SharePermission::Editor => write!(f, "editor"),
            SharePermission::Commenter => write!(f, "commenter"),
            SharePermission::Viewer => write!(f, "viewer"),
        }
    }
}

impl std::str::FromStr for SharePermission {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_lowercase().as_str() {
            "owner" => Ok(SharePermission::Owner),
            "editor" => Ok(SharePermission::Editor),
            "commenter" => Ok(SharePermission::Commenter),
            "viewer" => Ok(SharePermission::Viewer),
            _ => Err(format!("Invalid permission: {}", s)),
        }
    }
}

/// A share invitation.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareInvite {
    pub id: String,
    pub resource_path: String,
    pub resource_type: ResourceType,
    pub owner_id: String,
    pub owner_email: String,
    pub invitee_email: String,
    pub permission: SharePermission,
    pub created_at: i64,
    pub accepted_at: Option<i64>,
    pub invitee_id: Option<String>,
}

/// Request to create a share.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateShareRequest {
    pub resource_path: String,
    pub resource_type: ResourceType,
    pub invitee_email: String,
    pub permission: SharePermission,
}

impl CreateShareRequest {
    pub fn is_valid(&self) -> bool {
        !self.resource_path.is_empty() && !self.invitee_email.is_empty()
    }
}

/// Request to update a share's permission.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateShareRequest {
    pub permission: SharePermission,
}

/// Response for share operations.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareResponse {
    pub success: bool,
    pub share: Option<ShareInvite>,
    pub message: Option<String>,
}

impl ShareResponse {
    pub fn success(share: ShareInvite) -> Self {
        Self {
            success: true,
            share: Some(share),
            message: None,
        }
    }

    pub fn error(message: &str) -> Self {
        Self {
            success: false,
            share: None,
            message: Some(message.to_string()),
        }
    }
}

/// List of shares response.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListSharesResponse {
    pub success: bool,
    pub shares: Vec<ShareInvite>,
}

impl ListSharesResponse {
    pub fn new(shares: Vec<ShareInvite>) -> Self {
        Self {
            success: true,
            shares,
        }
    }
}

/// Effective permission for a user on a resource.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectivePermission {
    pub resource_path: String,
    pub permission: SharePermission,
    pub source: PermissionSource,
}

/// Source of a permission.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PermissionSource {
    /// User owns this resource.
    Owner,
    /// Direct share on this resource.
    Direct,
    /// Inherited from a parent folder share.
    Inherited,
}
